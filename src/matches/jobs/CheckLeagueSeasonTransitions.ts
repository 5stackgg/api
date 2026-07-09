import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CheckLeagueSeasonTransitions extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  async process(): Promise<number> {
    let transitions = 0;

    const opened = await this.postgres.query<{ id: string }[]>(
      `
      UPDATE league_seasons
      SET status = 'RegistrationOpen'
      WHERE status = 'Setup'
        AND signup_opens_at IS NOT NULL
        AND signup_opens_at <= NOW()
      RETURNING id;
      `,
    );
    transitions += opened.length;

    const closed = await this.postgres.query<{ id: string }[]>(
      `
      UPDATE league_seasons
      SET status = 'RegistrationClosed'
      WHERE status = 'RegistrationOpen'
        AND signup_closes_at IS NOT NULL
        AND signup_closes_at <= NOW()
      RETURNING id;
      `,
    );
    transitions += closed.length;

    const started = await this.postgres.query<{ id: string }[]>(
      `
      UPDATE league_seasons ls
      SET status = 'Live'
      WHERE ls.status = 'RegistrationClosed'
        AND ls.starts_at IS NOT NULL
        AND ls.starts_at <= NOW()
        AND EXISTS (
          SELECT 1 FROM league_team_seasons lts
          WHERE lts.league_season_id = ls.id
            AND lts.status = 'Approved'
            AND lts.assigned_division_id IS NOT NULL
          GROUP BY lts.assigned_division_id
          HAVING COUNT(*) >= 4
        )
      RETURNING id;
      `,
    );
    transitions += started.length;

    const playoffs = await this.postgres.query<{ id: string }[]>(
      `
      UPDATE league_seasons ls
      SET status = 'Playoffs'
      WHERE ls.status = 'Live'
        AND EXISTS (
          SELECT 1 FROM league_season_divisions lsd
          WHERE lsd.league_season_id = ls.id AND lsd.tournament_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM league_season_divisions lsd
          JOIN tournaments t ON t.id = lsd.tournament_id
          JOIN tournament_stages ts ON ts.tournament_id = t.id AND ts."order" = 1
          JOIN tournament_brackets tb ON tb.tournament_stage_id = ts.id
          WHERE lsd.league_season_id = ls.id
            AND t.status = 'Live'
            AND tb.finished = false
            AND tb.bye = false
        )
      RETURNING id;
      `,
    );
    transitions += playoffs.length;

    const finished = await this.postgres.query<{ id: string }[]>(
      `
      UPDATE league_seasons ls
      SET status = 'Finished'
      WHERE ls.status IN ('Live', 'Playoffs')
        AND EXISTS (
          SELECT 1 FROM league_season_divisions lsd
          WHERE lsd.league_season_id = ls.id AND lsd.tournament_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM league_season_divisions lsd
          JOIN tournaments t ON t.id = lsd.tournament_id
          WHERE lsd.league_season_id = ls.id
            AND t.status NOT IN ('Finished', 'Cancelled', 'CancelledMinTeams')
        )
      RETURNING id;
      `,
    );
    transitions += finished.length;

    if (transitions > 0) {
      this.logger.log(`${transitions} league season transitions applied`);
    }

    return transitions;
  }
}
