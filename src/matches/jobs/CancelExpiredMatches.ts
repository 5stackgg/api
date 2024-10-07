import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CancelExpiredMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  async process(): Promise<number> {
    const { update_matches } = await this.hasura.mutation({
      update_matches: {
        __args: {
          where: {
            _and: [
              {
                status: {
                  _neq: "Canceled"
                }
              },
              {
                is_tournament_match: {
                  _eq: false,
                },
              },
              {
                cancels_at: {
                  _is_null: false,
                },
              },
              {
                cancels_at: {
                  _lte: new Date(),
                },
              },
            ],
          },
          _set: {
            status: "Canceled",
          },
        },
        affected_rows: true,
      },
    });

    const tournamentMatches = await this.getTournamentMatches();
    for (const tournamentMatch of tournamentMatches) {
      await this.forfeitMatch(tournamentMatch);
    }

    const totalCanceledMatches =
      update_matches.affected_rows + tournamentMatches.length;
    if (totalCanceledMatches > 0) {
      this.logger.log(`canceled ${totalCanceledMatches} matches`);
    }

    return totalCanceledMatches;
  }

  private async forfeitMatch(
    match: Awaited<ReturnType<typeof this.getTournamentMatches>>[number],
  ) {
    const winningLineupId = match.lineup_1.is_ready
      ? match.lineup_1.id
      : match.lineup_2.id;
    void this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: match.id,
          },
          _set: {
            status: "Forfeit",
            winning_lineup_id: winningLineupId,
          },
        },
        __typename: true,
      },
    });
  }

  private async getTournamentMatches() {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            _and: [
              {
                is_tournament_match: {
                  _eq: true,
                },
              },
              {
                cancels_at: {
                  _is_null: false,
                },
              },
              {
                cancels_at: {
                  _lte: new Date(),
                },
              },
            ],
          },
        },
        id: true,
        is_tournament_match: true,
        lineup_1: {
          id: true,
          is_ready: true,
        },
        lineup_2: {
          id: true,
          is_ready: true,
        },
      },
    });

    return matches;
  }
}
