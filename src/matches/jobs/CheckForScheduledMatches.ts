import { Processor, WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { HasuraService } from "../../hasura/hasura.service";
import { Logger } from "@nestjs/common";

@Processor(MatchQueues.ScheduledMatches)
export class CheckForScheduledMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  async process(): Promise<number> {
    const fifteenMinutesAgo = new Date();
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    const { update_matches } = await this.hasura.mutation({
      update_matches: {
        __args: {
          where: {
            _and: [
              {
                scheduled_at: {
                  _is_null: false,
                },
              },
              {
                scheduled_at: {
                  _lte: fifteenMinutesAgo,
                },
              },
              {
                status: {
                  _eq: "Scheduled",
                },
              },
            ],
          },
          _set: {
            status: "WaitingForCheckIn",
          },
        },
        affected_rows: true,
      },
    });

    if (update_matches.affected_rows > 0) {
      this.logger.log(`${update_matches.affected_rows} matches started`);
    }

    return update_matches.affected_rows;
  }
}
