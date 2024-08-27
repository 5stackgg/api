import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ForfeitNonReadyTournamentMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  async process(job: Job): Promise<number> {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            _and: [
              {
                status: {
                  _eq: "WaitingForCheckIn",
                },
              },
              {
                is_tournament_match: {
                  _eq: true,
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

    for (const match of matches) {
      try {
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
      } catch (error) {
        this.logger.warn(`unable to update match (${match.id}) winner`, error);
      }
    }

    return matches.length;
  }
}
