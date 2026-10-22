import { DelayedError, Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { PlayerEloRecomputeService } from "../player-elo-recompute.service";

@UseQueue("Matches", MatchQueues.EloCalculation)
export class EloCalculation extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly eloRecompute: PlayerEloRecomputeService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const { matchId } = job.data;

    // A rebuild holds player_elo half empty, so a rating read from it now would
    // start from the wrong place and stay that way.
    if (await this.eloRecompute.isRebuilding()) {
      await job.moveToDelayed(
        Date.now() + PlayerEloRecomputeService.RETRY_DELAY_MS,
        job.token,
      );
      throw new DelayedError();
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
