import { Job } from "bullmq";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
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
  async process(): Promise<void> {
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
                  _lte: new Date(),
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
      this.logger.log(`${update_matches.affected_rows} where started`);
    }

    return;
  }
}
