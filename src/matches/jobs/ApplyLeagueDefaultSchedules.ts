import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

/**
 * Weekly default-time fallback for league matchups: any regular-season
 * matchup the two captains never agreed on gets the match week's default
 * time stamped on its bracket shortly before that time arrives. The existing
 * CheckForScheduledTournamentBrackets cron then materializes the match.
 */
@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ApplyLeagueDefaultSchedules extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  async process(): Promise<number> {
    // Legacy league seasons gate rounds by league_match_weeks; converged
    // seasons and plain tournaments use per-stage windows. Run both.
    const rows = await this.postgres.query<{ stamped: number }[]>(
      `SELECT apply_league_default_schedules() + apply_tournament_default_schedules() AS stamped;`,
    );

    const stamped = rows[0]?.stamped ?? 0;

    if (stamped > 0) {
      this.logger.log(`${stamped} matchups defaulted to their window time`);
    }

    return stamped;
  }
}
