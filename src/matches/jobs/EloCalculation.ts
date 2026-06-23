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

    const ranked = await this.postgres.query<Array<{ ranked: boolean }>>(
      `SELECT mo.ranked
         FROM matches m
         JOIN match_options mo ON mo.id = m.match_options_id
        WHERE m.id = $1`,
      [matchId],
    );

    if (ranked.at(0)?.ranked === false) {
      this.logger.log(`skipping ELO for unranked match ${matchId}`);
      return;
    }

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
