import { Processor, WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { HasuraService } from "../../hasura/hasura.service";
import { Logger } from "@nestjs/common";

@Processor(MatchQueues.ScheduledMatches)
export class CancelNonReadyMatches extends WorkerHost {
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
                  _eq: "WaitingForCheckIn",
                },
              },
              {
                is_tournament_match: {
                  _eq: false,
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

    if (update_matches.affected_rows > 0) {
      this.logger.log(`canceled ${update_matches.affected_rows} matches`);
    }

    return update_matches.affected_rows;
  }
}