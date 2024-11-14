import { Controller } from "@nestjs/common";
import { TypeSenseService } from "./type-sense.service";
import { HasuraEvent } from "../hasura/hasura.controller";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import {
  player_sanctions_set_input,
  players_set_input,
  team_roster_set_input,
} from "../../generated";
import { CacheService } from "../cache/cache.service";
import { HasuraService } from "../hasura/hasura.service";
import { RefreshPlayerJob } from "./jobs/RefreshPlayer";
import { Queue } from "bullmq";
import { TypesenseQueues } from "./enums/TypesenseQueues";
import { InjectQueue } from "@nestjs/bullmq";

@Controller("type-sense")
export class TypeSenseController {
  constructor(
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly typeSense: TypeSenseService,
    @InjectQueue(TypesenseQueues.TypeSense) private queue: Queue,
  ) {}

  @HasuraEvent()
  public async player_events(data: HasuraEventData<players_set_input>) {
    await this.cache.forget(
      HasuraService.PLAYER_ROLE_CACHE_KEY(
        `${data.new.steam_id || data.old.steam_id}`,
      ),
    );

    if (data.op === "DELETE") {
      await this.typeSense.removePlayer(data.old.steam_id);
      return;
    }

    await this.typeSense.updatePlayer(data.new.steam_id as string);
  }

  @HasuraEvent()
  public async player_sanctions(
    data: HasuraEventData<player_sanctions_set_input>,
  ) {
    const endOfSanction = data.new.remove_sanction_date;

    if (endOfSanction) {
      const jobId = `player-sanctions:${data.new.type}:${data.new.player_steam_id}`;
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

    if (data.new.type === "ban") {
      const { match_lineup_players } = await this.hasura.query({
        match_lineup_players: {
          __args: {
            where: {
              steam_id: {
                _eq: data.new.player_steam_id,
              },
              lineup: {
                v_match_lineup: {
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
          },
          id: true,
          lineup: {
            id: true,
            v_match_lineup: {
              match: {
                id: true,
                status: true,
                lineup_1_id: true,
                lineup_2_id: true,
              },
            },
          },
        },
      });

      for (const matchLineupPlayer of match_lineup_players) {
        switch (matchLineupPlayer.lineup.v_match_lineup.match.status) {
          case "Live":
            await this.hasura.mutation({
              update_matches_by_pk: {
                __args: {
                  pk_columns: {
                    id: matchLineupPlayer.lineup.v_match_lineup.match.id,
                  },
                  _set: {
                    status: "Forfeit",
                    winning_lineup_id:
                      matchLineupPlayer.lineup.id ===
                      matchLineupPlayer.lineup.v_match_lineup.match.lineup_1_id
                        ? matchLineupPlayer.lineup.v_match_lineup.match
                            .lineup_2_id
                        : matchLineupPlayer.lineup.v_match_lineup.match
                            .lineup_1_id,
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
                    id: matchLineupPlayer.lineup.v_match_lineup.match.id,
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
}
