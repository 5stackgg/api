import Redis from "ioredis";
import { Queue } from "bullmq";
import { Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import { CacheService } from "src/cache/cache.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { DraftGame } from "./types/DraftGame";
import { DraftGameError } from "./types/DraftGameError";
import { DraftGameQueues } from "./enums/DraftGameQueues";
import { DraftGameService } from "./draft-game.service";
import { DraftMatchService } from "./draft-match.service";

@Injectable()
export class DraftService {
  public redis: Redis;

  public static readonly PICK_SECONDS = 30;

  private static getDraftPickDeadlineKey(draftGameId: string): string {
    return `draft-games:v1:${draftGameId}:deadline`;
  }

  constructor(
    public readonly logger: Logger,
    public readonly hasura: HasuraService,
    public readonly cache: CacheService,
    public readonly redisManager: RedisManagerService,
    @Inject(forwardRef(() => DraftGameService))
    private readonly draftGameService: DraftGameService,
    private readonly draftMatchService: DraftMatchService,
    @InjectQueue(DraftGameQueues.DraftGames) private queue: Queue,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async beginDraft(draftGameId: string) {
    return this.cache.lock(DraftGameService.lockKey(draftGameId), async () => {
      const draftGame = await this.draftGameService.getDraftGame(draftGameId);

      if (!draftGame || draftGame.match_id) {
        return;
      }

      const perTeam = draftGame.capacity / 2;
      const accepted = this.draftGameService.acceptedPlayers(draftGame);

      if (draftGame.mode === "Teams") {
        if (!draftGame.team_1_id) {
          return;
        }
        await this.draftMatchService.finalize(draftGameId);
        return;
      }

      if (draftGame.mode === "Host") {
        const team1 = accepted.filter((player) => player.lineup === 1).length;
        const team2 = accepted.filter((player) => player.lineup === 2).length;
        if (team1 !== perTeam || team2 !== perTeam) {
          return;
        }
        await this.draftMatchService.finalize(draftGameId);
        return;
      }

      if (draftGame.mode === "Pug") {
        if (accepted.length !== draftGame.capacity) {
          return;
        }
        await this.autoSplit(draftGame);
        await this.draftMatchService.finalize(draftGameId);
        return;
      }

      if (draftGame.mode === "Captains") {
        if (accepted.length !== draftGame.capacity) {
          return;
        }
        await this.runDraftStart(draftGameId);
      }
    });
  }

  private async runDraftStart(draftGameId: string) {
    let draftGame = await this.draftGameService.getDraftGame(draftGameId);

    if (!draftGame || !["Open", "Filled"].includes(draftGame.status)) {
      return;
    }

    const requested = draftGame.players.filter(
      (player) => player.status === "Requested",
    );

    if (requested.length > 0) {
      await this.hasura.mutation({
        delete_draft_game_players: {
          __args: {
            where: {
              draft_game_id: { _eq: draftGameId },
              status: { _eq: "Requested" },
            },
          },
          __typename: true,
        },
      });

      draftGame = await this.draftGameService.getDraftGame(draftGameId);

      if (!draftGame || draftGame.status !== "Open") {
        return;
      }
    }

    if (draftGame.mode === "Host") {
      await this.hasura.mutation({
        update_draft_games_by_pk: {
          __args: {
            pk_columns: { id: draftGameId },
            _set: { status: "Drafting", current_pick_lineup: null },
          },
          __typename: true,
        },
      });
      return;
    }

    if (draftGame.mode === "Pug") {
      await this.autoSplit(draftGame);
      await this.draftMatchService.finalize(draftGameId);
      return;
    }

    // Manual: the host has already designated the two captains (is_captain +
    // lineup). Keep them, return everyone else to the pool, and start drafting.
    if ((draftGame.captain_selection as string) === "Manual") {
      const captain1 = draftGame.players.find(
        (player) => player.is_captain && player.lineup === 1,
      );
      const captain2 = draftGame.players.find(
        (player) => player.is_captain && player.lineup === 2,
      );

      if (!captain1 || !captain2) {
        return;
      }

      await this.hasura.mutation({
        update_draft_games_by_pk: {
          __args: {
            pk_columns: { id: draftGameId },
            _set: { status: "SelectingCaptains" },
          },
          __typename: true,
        },
      });

      await this.hasura.mutation({
        update_draft_game_players: {
          __args: {
            where: {
              draft_game_id: { _eq: draftGameId },
              is_captain: { _eq: false },
            },
            _set: { lineup: null, pick_order: null },
          },
          __typename: true,
        },
      });

      await this.hasura.mutation({
        update_draft_game_players_by_pk: {
          __args: {
            pk_columns: {
              draft_game_id: draftGameId,
              steam_id: captain1.steam_id,
            },
            _set: { is_captain: true, lineup: 1, pick_order: 0 },
          },
          __typename: true,
        },
      });

      await this.hasura.mutation({
        update_draft_game_players_by_pk: {
          __args: {
            pk_columns: {
              draft_game_id: draftGameId,
              steam_id: captain2.steam_id,
            },
            _set: { is_captain: true, lineup: 2, pick_order: 0 },
          },
          __typename: true,
        },
      });

      await this.beginDrafting(draftGameId);
      return;
    }

    await this.hasura.mutation({
      update_draft_games_by_pk: {
        __args: {
          pk_columns: { id: draftGameId },
          _set: { status: "SelectingCaptains" },
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      update_draft_game_players: {
        __args: {
          where: { draft_game_id: { _eq: draftGameId } },
          _set: { lineup: null, pick_order: null, is_captain: false },
        },
        __typename: true,
      },
    });

    const [captain1, captain2] = this.selectCaptains(draftGame);

    await this.hasura.mutation({
      update_draft_game_players_by_pk: {
        __args: {
          pk_columns: { draft_game_id: draftGameId, steam_id: captain1 },
          _set: { is_captain: true, lineup: 1, pick_order: 0 },
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      update_draft_game_players_by_pk: {
        __args: {
          pk_columns: { draft_game_id: draftGameId, steam_id: captain2 },
          _set: { is_captain: true, lineup: 2, pick_order: 0 },
        },
        __typename: true,
      },
    });

    await this.beginDrafting(draftGameId);
  }

  private selectCaptains(draftGame: DraftGame): [string, string] {
    switch (draftGame.captain_selection) {
      case "HostAndNext":
        return this.selectCaptainsHostAndNext(draftGame);
      case "RandomTwo":
        return this.selectCaptainsRandomTwo(draftGame);
      case "TopEloTwo":
      default:
        return this.selectCaptainsTopEloTwo(draftGame);
    }
  }

  private selectCaptainsTopEloTwo(draftGame: DraftGame): [string, string] {
    const accepted = this.draftGameService.acceptedPlayers(draftGame);

    if (accepted.length < 2) {
      throw new DraftGameError(
        "At least two accepted players are required to select captains",
      );
    }

    const sorted = [...accepted].sort(
      (a, b) => (b.elo_snapshot || 0) - (a.elo_snapshot || 0),
    );
    return [sorted[0].steam_id, sorted[1].steam_id];
  }

  private selectCaptainsHostAndNext(draftGame: DraftGame): [string, string] {
    const accepted = this.draftGameService.acceptedPlayers(draftGame);

    if (accepted.length < 2) {
      throw new DraftGameError(
        "At least two accepted players are required to select captains",
      );
    }

    const others = accepted
      .filter((player) => player.steam_id !== draftGame.host_steam_id)
      .sort((a, b) => (b.elo_snapshot || 0) - (a.elo_snapshot || 0));

    if (others.length === 0) {
      throw new DraftGameError(
        "At least two accepted players are required to select captains",
      );
    }

    return [draftGame.host_steam_id, others[0].steam_id];
  }

  private selectCaptainsRandomTwo(draftGame: DraftGame): [string, string] {
    const accepted = this.draftGameService.acceptedPlayers(draftGame);

    if (accepted.length < 2) {
      throw new DraftGameError(
        "At least two accepted players are required to select captains",
      );
    }

    const shuffled = this.shuffle(accepted);
    return [shuffled[0].steam_id, shuffled[1].steam_id];
  }

  private shuffle<T>(items: Array<T>): Array<T> {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1));
      const temp = result[index];
      result[index] = result[swap];
      result[swap] = temp;
    }
    return result;
  }

  private async autoSplit(draftGame: DraftGame) {
    const accepted = this.draftGameService.acceptedPlayers(draftGame);
    const counts: Record<number, number> = { 1: 0, 2: 0 };

    for (const player of accepted) {
      if (player.lineup === 1 || player.lineup === 2) {
        counts[player.lineup]++;
      }
    }

    const unassigned = accepted
      .filter((player) => player.lineup !== 1 && player.lineup !== 2)
      .sort((a, b) => (b.elo_snapshot || 0) - (a.elo_snapshot || 0));

    for (const player of unassigned) {
      const lineup = counts[1] <= counts[2] ? 1 : 2;
      counts[lineup]++;

      await this.hasura.mutation({
        update_draft_game_players_by_pk: {
          __args: {
            pk_columns: {
              draft_game_id: draftGame.id,
              steam_id: player.steam_id,
            },
            _set: { lineup, pick_order: counts[lineup] },
          },
          __typename: true,
        },
      });
    }
  }

  private async beginDrafting(draftGameId: string) {
    const draftGame = await this.draftGameService.getDraftGame(draftGameId);

    if (!draftGame) {
      return;
    }

    await this.hasura.mutation({
      update_draft_games_by_pk: {
        __args: {
          pk_columns: { id: draftGameId },
          _set: { status: "Drafting" },
        },
        __typename: true,
      },
    });

    const undrafted = draftGame.players.filter(
      (player) => player.lineup === null || player.lineup === undefined,
    );

    if (undrafted.length === 0) {
      await this.draftMatchService.finalize(draftGameId);
      return;
    }

    // Team 1 always makes the first pick; every turn after this is driven by
    // the SQL pattern via the draft_game_picks trigger.
    await this.setCurrentPick(draftGameId, 1);
    await this.startPickTimer(draftGameId, 0);
  }

  public async autoPick(draftGameId: string, pickCount: number) {
    return this.cache.lock(DraftGameService.lockKey(draftGameId), async () => {
      const draftGame = await this.draftGameService.getDraftGame(draftGameId);

      if (!draftGame || draftGame.status !== "Drafting" || draftGame.match_id) {
        return;
      }

      if (this.draftedCount(draftGame) !== pickCount) {
        return;
      }

      const undrafted = draftGame.players
        .filter(
          (player) => player.lineup === null || player.lineup === undefined,
        )
        .sort((a, b) => (b.elo_snapshot || 0) - (a.elo_snapshot || 0));

      if (undrafted.length === 0) {
        return;
      }

      const captain = draftGame.players.find(
        (player) =>
          player.is_captain && player.lineup === draftGame.current_pick_lineup,
      );

      if (!captain) {
        return;
      }

      await this.hasura.mutation({
        insert_draft_game_picks_one: {
          __args: {
            object: {
              draft_game_id: draftGameId,
              captain_steam_id: captain.steam_id,
              picked_steam_id: undrafted[0].steam_id,
              lineup: draftGame.current_pick_lineup,
              auto_picked: true,
            },
          },
          __typename: true,
        },
      });
    });
  }

  public async applyPick(draftGameId: string) {
    return this.cache.lock(DraftGameService.lockKey(draftGameId), async () => {
      const draftGame = await this.draftGameService.getDraftGame(draftGameId);

      if (!draftGame || draftGame.match_id) {
        return;
      }

      // The draft_game_picks trigger already assigned the player, advanced the
      // turn, and (on the final pick) auto-assigned the last player and moved the
      // draft to CreatingMatch. React to whatever state that left us in.
      if (draftGame.status === "CreatingMatch") {
        await this.removeAllPickTimers(draftGameId);
        await this.draftMatchService.finalize(draftGameId);
        return;
      }

      if (draftGame.status !== "Drafting") {
        return;
      }

      await this.startPickTimer(draftGameId, this.draftedCount(draftGame));
    });
  }

  private draftedCount(draftGame: DraftGame): number {
    return draftGame.players.filter(
      (player) =>
        !player.is_captain &&
        player.lineup !== null &&
        player.lineup !== undefined,
    ).length;
  }

  private async setCurrentPick(draftGameId: string, lineup: number) {
    await this.hasura.mutation({
      update_draft_games_by_pk: {
        __args: {
          pk_columns: { id: draftGameId },
          _set: { current_pick_lineup: lineup },
        },
        __typename: true,
      },
    });
  }

  private async startPickTimer(draftGameId: string, pickCount: number) {
    const deadline = new Date(Date.now() + DraftService.PICK_SECONDS * 1000);

    await this.redis.set(
      DraftService.getDraftPickDeadlineKey(draftGameId),
      deadline.toISOString(),
      "EX",
      DraftService.PICK_SECONDS + 10,
    );

    await this.hasura.mutation({
      update_draft_games_by_pk: {
        __args: {
          pk_columns: { id: draftGameId },
          _set: { pick_deadline: deadline.toISOString() },
        },
        __typename: true,
      },
    });

    await this.removePickTimer(draftGameId);

    await this.queue.add(
      "DraftPickTimeout",
      {
        draftGameId,
        pickCount,
      },
      {
        delay: DraftService.PICK_SECONDS * 1000,
        jobId: `draft.pick.${draftGameId}.${pickCount}`,
      },
    );
  }

  private async removePickTimer(draftGameId: string) {
    const prefix = `draft.pick.${draftGameId}.`;
    try {
      const delayed = await this.queue.getDelayed();
      for (const job of delayed) {
        if (job.id?.startsWith(prefix)) {
          await job.remove();
        }
      }
    } catch {
      this.logger.debug(`pick-timer jobs ${draftGameId} not found`);
    }
  }

  public async removeAllPickTimers(draftGameId: string) {
    await this.removePickTimer(draftGameId);
    await this.redis.del(DraftService.getDraftPickDeadlineKey(draftGameId));
  }
}
