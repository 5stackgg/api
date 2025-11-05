import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CleanAbandonedMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  async process(): Promise<number> {
    const oneWeekAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7);

    const { delete_abandoned_matches } = await this.hasura.mutation({
      delete_abandoned_matches: {
        __args: {
          where: {
            abandoned_at: {
              _lt: oneWeekAgo,
            },
          },
        },
        affected_rows: true,
      },
    });

    if (delete_abandoned_matches.affected_rows > 0) {
      this.logger.log(
        `${delete_abandoned_matches.affected_rows} abandoned matches deleted`,
      );
    }

    return delete_abandoned_matches.affected_rows;
  }
}
