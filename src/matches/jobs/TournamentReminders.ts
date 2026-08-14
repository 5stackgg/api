import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { NotificationsService } from "../../notifications/notifications.service";

type DueTournament = {
  id: string;
  name: string;
  start: string;
  label: string;
  window: string;
};

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class TournamentReminders extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(): Promise<number> {
    // Two reminder windows, each deduped the way LeagueWeekReminders dedupes
    // its own: a distinct entity_id per (tournament, window) makes a NOT EXISTS
    // check enough, with no extra state on the tournament itself.
    //
    // The floor is what stops both windows firing in the same pass for a
    // tournament created 90 minutes before it starts.
    const due = await this.postgres.query<DueTournament[]>(
      `WITH reminder_windows(window_key, label, lead_time, floor_time) AS (
         VALUES ('1d', 'starts in about a day', interval '24 hours', interval '2 hours'),
                ('2h', 'starts in about 2 hours', interval '2 hours', interval '0')
       )
       SELECT t.id::text AS id, t.name, t."start", w.label, w.window_key AS window
         FROM tournaments t
         CROSS JOIN reminder_windows w
        WHERE t.status IN ('RegistrationOpen', 'RegistrationClosed')
          AND t."start" > now() + w.floor_time
          AND t."start" <= now() + w.lead_time
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.type = 'TournamentReminder'
               AND n.entity_id = t.id::text || ':' || w.window_key
          )`,
    );

    let sent = 0;
    for (const tournament of due) {
      const recipients = await this.postgres.query<
        Array<{ steam_id: string }>
      >(
        `SELECT DISTINCT steam_id::text AS steam_id FROM (
                 SELECT tt.owner_steam_id AS steam_id
                   FROM tournament_teams tt
                  WHERE tt.tournament_id = $1::uuid
                    AND tt.owner_steam_id IS NOT NULL
                  UNION
                 SELECT ttr.player_steam_id AS steam_id
                   FROM tournament_team_roster ttr
                  WHERE ttr.tournament_id = $1::uuid
                    AND ttr.player_steam_id IS NOT NULL
               ) roster`,
        [tournament.id],
      );

      if (recipients.length === 0) {
        continue;
      }

      await this.notifications.notifyPlayers("TournamentReminder", {
        title: "Tournament starting soon",
        message: `<a href="/tournaments/${tournament.id}"><b>${NotificationsService.escapeHtml(
          tournament.name,
        )}</b></a> ${tournament.label}.`,
        role: "user",
        entity_id: `${tournament.id}:${tournament.window}`,
        steamIds: recipients.map((recipient) => recipient.steam_id),
      });

      sent++;
    }

    if (sent > 0) {
      this.logger.log(`${sent} tournament start reminders sent`);
    }

    return sent;
  }
}
