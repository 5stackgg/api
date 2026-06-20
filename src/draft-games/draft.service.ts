import Redis from "ioredis";
import { Queue } from "bullmq";
import { Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { e_draft_game_draft_order_enum } from "generated";
import { HasuraService } from "src/hasura/hasura.service";
import { CacheService } from "src/cache/cache.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { DraftGame, DraftGamePlayer } from "./types/DraftGame";
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

    const lineup = this.nextLineup(draftGame, 0);
    await this.setCurrentPick(draftGameId, lineup);
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

  public async applyPick(draftGameId: string, pickedSteamId: string) {
    return this.cache.lock(DraftGameService.lockKey(draftGameId), async () => {
      const draftGame = await this.draftGameService.getDraftGame(draftGameId);

      if (!draftGame || draftGame.status !== "Drafting" || draftGame.match_id) {
        return;
      }

      const target = draftGame.players.find(
        (player) => player.steam_id === pickedSteamId,
      );

      if (!target || target.lineup != null) {
        return;
      }

      await this.performPick(draftGame, target);
    });
  }

  private async performPick(draftGame: DraftGame, target: DraftGamePlayer) {
    const currentLineup = draftGame.current_pick_lineup;
    const captain = draftGame.players.find(
      (player) => player.is_captain && player.lineup === currentLineup,
    );

    if (!captain) {
      return;
    }

    const pickCount = this.draftedCount(draftGame);
    const currentLineupCount = draftGame.players.filter(
      (player) => player.lineup === currentLineup,
    ).length;

    await this.hasura.mutation({
      update_draft_game_players_by_pk: {
        __args: {
          pk_columns: {
            draft_game_id: draftGame.id,
            steam_id: target.steam_id,
          },
          _set: { lineup: currentLineup, pick_order: currentLineupCount },
        },
        __typename: true,
      },
    });

    await this.removePickTimer(draftGame.id);

    const undrafted = draftGame.players.filter(
      (player) =>
        player.steam_id !== target.steam_id &&
        (player.lineup === null || player.lineup === undefined),
    );

    if (undrafted.length === 1) {
      const updated = await this.draftGameService.getDraftGame(draftGame.id);

      if (!updated) {
        await this.removeAllPickTimers(draftGame.id);
        return;
      }

      const lineup = this.nextLineup(updated, pickCount + 1);
      const lineupCount = updated.players.filter(
        (player) => player.lineup === lineup,
      ).length;
      await this.hasura.mutation({
        update_draft_game_players_by_pk: {
          __args: {
            pk_columns: {
              draft_game_id: draftGame.id,
              steam_id: undrafted[0].steam_id,
            },
            _set: { lineup, pick_order: lineupCount },
          },
          __typename: true,
        },
      });

      await this.removeAllPickTimers(draftGame.id);
      await this.draftMatchService.finalize(draftGame.id);
      return;
    }

    if (undrafted.length === 0) {
      await this.removeAllPickTimers(draftGame.id);
      await this.draftMatchService.finalize(draftGame.id);
      return;
    }

    const updated = await this.draftGameService.getDraftGame(draftGame.id);

    if (!updated) {
      await this.removeAllPickTimers(draftGame.id);
      return;
    }

    const nextLineup = this.nextLineup(updated, pickCount + 1);
    await this.setCurrentPick(draftGame.id, nextLineup);
    await this.startPickTimer(draftGame.id, pickCount + 1);
  }

  private draftedCount(draftGame: DraftGame): number {
    return draftGame.players.filter(
      (player) =>
        !player.is_captain &&
        player.lineup !== null &&
        player.lineup !== undefined,
    ).length;
  }

  private nextLineup(draftGame: DraftGame, pickCount: number): number {
    const perTeam = draftGame.capacity / 2;

    const counts = { 1: 0, 2: 0 };
    for (const player of draftGame.players) {
      if (player.lineup === 1) {
        counts[1]++;
      }
      if (player.lineup === 2) {
        counts[2]++;
      }
    }

    if (counts[1] >= perTeam) {
      return 2;
    }

    if (counts[2] >= perTeam) {
      return 1;
    }

    const order = this.getDraftOrder(
      draftGame.draft_order,
      draftGame.capacity - 2,
    );

    return order[pickCount] || 1;
  }

  private getDraftOrder(
    draftOrder: e_draft_game_draft_order_enum,
    picks: number,
  ): Array<number> {
    if (picks <= 0) {
      return [];
    }

    if (draftOrder === "Alternating") {
      return Array.from({ length: picks }, (_, index) =>
        index % 2 === 0 ? 1 : 2,
      );
    }

    const order: Array<number> = [1];
    let next = 2;
    while (order.length < picks) {
      order.push(next);
      if (order.length < picks) {
        order.push(next);
      }
      next = next === 1 ? 2 : 1;
    }
    return order;
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
