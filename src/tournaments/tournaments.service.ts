import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { e_match_status_enum, order_by } from "../../generated/zeus";

@Injectable()
export class TournamentsService {
  constructor(
    public readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {}

  public async checkMatch(matchId: string) {
    console.info("CHECK MATCH");
    // const tournamentId = await this.hasura.query({
    //
    // })
  }

  public async scheduleMatches(tournamentId: string) {
    const { tournaments_by_pk } = await this.hasura.query({
      tournaments_by_pk: [
        {
          id: tournamentId,
        },
        {
          match_options_id: true,
          organizer_steam_id: true,
          stages: [
            {
              order_by: [
                {
                  order: order_by.asc,
                },
              ],
              where: {
                brackets: {
                  tournament_team_id_1: {
                    _is_null: false,
                  },
                  tournament_team_id_2: {
                    _is_null: false,
                  },
                  match_id: {
                    _is_null: true,
                  },
                },
              },
              limit: 1,
            },
            {
              brackets: [
                {
                  where: {
                    tournament_team_id_1: {
                      _is_null: false,
                    },
                    tournament_team_id_2: {
                      _is_null: false,
                    },
                    match_id: {
                      _is_null: true,
                    },
                  },
                  order_by: [
                    {
                      match_id: order_by.asc,
                    },
                  ],
                },
                {
                  id: true,
                  team_1: {
                    roster: [
                      {},
                      {
                        player_steam_id: true,
                      },
                    ],
                  },
                  team_2: {
                    roster: [
                      {},
                      {
                        player_steam_id: true,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    for (const stage of tournaments_by_pk.stages) {
      for (const bracket of stage.brackets) {
        const { insert_matches_one } = await this.hasura.mutation({
          insert_matches_one: [
            {
              object: {
                match_options_id: tournaments_by_pk.match_options_id,
                // TODO - its not hard coced to veto
                status: e_match_status_enum.Veto,
                organizer_steam_id: tournaments_by_pk.organizer_steam_id,
                // TODO - coaches
                lineups: {
                  data: [
                    {
                      lineup_players: {
                        data: bracket.team_1.roster.map(
                          ({ player_steam_id }) => {
                            return {
                              steam_id: player_steam_id,
                            };
                          },
                        ),
                      },
                    },
                    {
                      lineup_players: {
                        data: bracket.team_2.roster.map(
                          ({ player_steam_id }) => {
                            return {
                              steam_id: player_steam_id,
                            };
                          },
                        ),
                      },
                    },
                  ],
                },
              },
            },
            {
              id: true,
            },
          ],
        });

        await this.hasura.mutation({
          update_tournament_brackets_by_pk: [
            {
              pk_columns: {
                id: bracket.id,
              },
              _set: {
                match_id: insert_matches_one.id,
              },
            },
            {
              id: true,
            },
          ],
        });
      }
    }
  }
}
