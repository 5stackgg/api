import { Controller, Logger } from "@nestjs/common";
import { TypeSenseService } from "./type-sense.service";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import {
  player_elo_set_input,
  player_sanctions_set_input,
  players_set_input,
  team_roster_set_input,
} from "../../generated";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { RefreshPlayerJob } from "./jobs/RefreshPlayer";
import { RefreshAllPlayersJob } from "./jobs/RefreshAllPlayers";
import { NotificationsService } from "src/notifications/notifications.service";
import { Queue } from "bullmq";
import { TypesenseQueues } from "./enums/TypesenseQueues";
import { InjectQueue } from "@nestjs/bullmq";
import { SteamMatchHistoryQueues } from "src/steam-match-history/enums/SteamMatchHistoryQueues";
import { SteamBansService } from "src/steam-match-history/steam-bans.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";

@Controller("type-sense")
export class TypeSenseController {
  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly typeSense: TypeSenseService,
    private readonly notifications: NotificationsService,
    private readonly logger: Logger,
    @InjectQueue(TypesenseQueues.TypeSense) private queue: Queue,
    @InjectQueue(SteamMatchHistoryQueues.CheckSteamBans)
    private steamBansQueue: Queue,
    private readonly redisManager: RedisManagerService,
  ) {}

  @HasuraEvent()
  public async player_elo_events(data: HasuraEventData<player_elo_set_input>) {
    await this.typeSense.updatePlayer(
      (data.new.steam_id as string) || data.old.steam_id,
    );
  }

  @HasuraEvent()
  public async player_events(data: HasuraEventData<players_set_input>) {
    await this.cache.forget(
      HasuraService.PLAYER_ROLE_CACHE_KEY(
        `${data.new.steam_id || data.old.steam_id}`,
      ),
    );

    if (data.new.name && data.new.name !== data.old.name) {
      await this.cache.put(
        HasuraService.PLAYER_NAME_CACHE_KEY(
          `${data.new.steam_id || data.old.steam_id}`,
        ),
        data.new.name,
      );
    }

    if (data.op === "DELETE") {
      await this.typeSense.removePlayer(data.old.steam_id);
      return;
    }

    if (data.op === "INSERT") {
      void SteamBansService.enqueueChecks(
        this.redisManager.getConnection(),
        this.steamBansQueue,
        [data.new.steam_id as string],
      ).catch((error) =>
        this.logger.error(
          `failed to enqueue steam-ban check for player ${data.new.steam_id}`,
          error,
        ),
      );
    }

    await this.typeSense.updatePlayer(data.new.steam_id as string);
  }

  @HasuraEvent()
  public async player_sanctions(
    data: HasuraEventData<player_sanctions_set_input>,
  ) {
    if (data.op === "DELETE") {
      const jobId = `player-sanctions.${data.old.type}.${data.old.player_steam_id}`;
      await this.queue.remove(jobId);

      await this.queue.add(RefreshPlayerJob.name, {
        steamId: data.old.player_steam_id,
      });
      return;
    }

    if (data.op === "INSERT") {
      try {
        await this.notifications.queueSanctionNotification({
          sanctionId: data.new.id as string,
          steamId: data.new.player_steam_id as string,
          type: data.new.type as string,
          reason: data.new.reason as string | null,
        });
      } catch (error) {
        this.logger.error(
          `failed to queue co-player notifications for sanction on ${data.new.player_steam_id}`,
          error,
        );
      }
    }

    const endOfSanction = data.new.remove_sanction_date;

    if (endOfSanction) {
      const jobId = `player-sanctions.${data.new.type}.${data.new.player_steam_id}`;
      await this.queue.remove(jobId);

      await this.queue.add(
        RefreshPlayerJob.name,
        {
          steamId: data.new.player_steam_id,
        },
        {
          jobId,
          // Add a second to ensure sanction date is passed
          delay: new Date(endOfSanction).getTime() - Date.now() + 1000,
        },
      );
    }

    if (data.new.type === "ban" && !(data.new as { deleted_at?: string }).deleted_at) {
      const { match_lineup_players } = await this.hasura.query({
        match_lineup_players: {
          __args: {
            where: {
              steam_id: {
                _eq: data.new.player_steam_id,
              },
              lineup: {
                match: {
                  status: {
                    _nin: [
                      "Canceled",
                      "Finished",
                      "Forfeit",
                      "Tie",
                      "Surrendered",
                    ],
                  },
                },
              },
            },
          },
          id: true,
          lineup: {
            id: true,
            match: {
              id: true,
              status: true,
              lineup_1_id: true,
              lineup_2_id: true,
            },
          },
        },
      });

      for (const matchLineupPlayer of match_lineup_players) {
        switch (matchLineupPlayer.lineup.match.status) {
          case "Live":
            await this.hasura.mutation({
              update_matches_by_pk: {
                __args: {
                  pk_columns: {
                    id: matchLineupPlayer.lineup.match.id,
                  },
                  _set: {
                    status: "Forfeit",
                    winning_lineup_id:
                      matchLineupPlayer.lineup.id ===
                      matchLineupPlayer.lineup.match.lineup_1_id
                        ? matchLineupPlayer.lineup.match.lineup_2_id
                        : matchLineupPlayer.lineup.match.lineup_1_id,
                  },
                },
                __typename: true,
              },
            });
            break;
          case "PickingPlayers":
            await this.hasura.mutation({
              delete_match_lineup_players_by_pk: {
                __args: {
                  id: matchLineupPlayer.id,
                },
                __typename: true,
              },
            });
            break;
          default:
            await this.hasura.mutation({
              update_matches_by_pk: {
                __args: {
                  pk_columns: {
                    id: matchLineupPlayer.lineup.match.id,
                  },
                  _set: {
                    status: "Canceled",
                  },
                },
                __typename: true,
              },
            });
            break;
        }
      }
    }

    await this.typeSense.updatePlayer(data.new.player_steam_id as string);
  }

  @HasuraEvent()
  public async team_roster_events(
    data: HasuraEventData<team_roster_set_input>,
  ) {
    await this.typeSense.updatePlayer(
      (data.new.player_steam_id || data.old.player_steam_id) as string,
    );
  }

  @HasuraAction()
  public async refreshAllPlayers() {
    await this.queue.add(RefreshAllPlayersJob.name, {});
    return { success: true };
  }
}
