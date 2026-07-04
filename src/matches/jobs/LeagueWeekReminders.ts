import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { LeaguesService } from "../../leagues/leagues.service";

/**
 * Reminds both captains of league matchups that still have no agreed time
 * once the week's default tip-off is within 48 hours. Sent at most once per
 * matchup (deduped on the notification's entity_id).
 */
@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class LeagueWeekReminders extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly leagues: LeaguesService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const due = await this.postgres.query<
      Array<{ bracket_id: string; default_match_at: string }>
    >(
      `SELECT tb.id AS bracket_id, lmw.default_match_at
         FROM tournament_brackets tb
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id AND ts."order" = 1
         JOIN league_season_divisions lsd ON lsd.tournament_id = ts.tournament_id
         JOIN league_seasons ls ON ls.id = lsd.league_season_id AND ls.status = 'Live'
         JOIN league_match_weeks lmw
           ON lmw.league_season_id = ls.id
          AND lmw.week_number = tb.round
        WHERE tb.match_id IS NULL
          AND tb.finished = false
          AND tb.scheduled_at IS NULL
          AND tb.tournament_team_id_1 IS NOT NULL
          AND tb.tournament_team_id_2 IS NOT NULL
          AND lmw.default_match_at BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
            WHERE n.type = 'LeagueMatchUnscheduled'
              AND n.entity_id = tb.id::text
          )`,
    );

    let sent = 0;
    for (const row of due) {
      const context = await this.leagues.getBracketContext(row.bracket_id);
      if (!context) {
        continue;
      }
      const defaultTime = new Date(row.default_match_at).toUTCString();
      sent += await this.leagues.notifyManagers({
        leagueTeamSeasonIds: [
          context.team_1_league_team_season_id,
          context.team_2_league_team_season_id,
        ],
        type: "LeagueMatchUnscheduled",
        title: "League Matchup Unscheduled",
        message: `${this.leagues.matchupLabel(
          context,
        )} has no agreed time yet and will default to ${defaultTime}. Propose a time that works for both teams.`,
        entityId: row.bracket_id,
      });
    }

    if (sent > 0) {
      this.logger.log(
        `${sent} league unscheduled-matchup reminders sent for ${due.length} matchups`,
      );
    }

    return due.length;
  }
}
