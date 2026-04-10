import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

@UseQueue("Matches", MatchQueues.EloCalculation)
export class EloCalculation extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const { matchId } = job.data;

    try {
      await this.postgres.query(
        `
        SELECT generate_player_elo_for_match($1)
      `,
        [matchId],
      );
    } catch (error) {
      this.logger.error(
        `ELO calculation failed for match ${matchId} (attempt ${job.attemptsMade + 1})`,
        error,
      );
      throw error;
    }
  }
}
