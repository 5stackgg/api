import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { NotificationsService } from "../../notifications/notifications.service";

type DueEvent = {
  id: string;
  name: string;
  label: string;
  window: string;
  banner_filename: string | null;
};

type EndedSeason = {
  id: string;
  number: string | null;
};

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class EventReminders extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(): Promise<number> {
    return (
      (await this.remindUpcomingEvents()) + (await this.announceEndedSeasons())
    );
  }

  // Same shape as TournamentReminders: two windows, each with a floor so an
  // event created a day out doesn't fire both in the same pass, and a distinct
  // entity_id per (event, window) so NOT EXISTS is enough to dedupe.
  private async remindUpcomingEvents(): Promise<number> {
    const due = await this.postgres.query<DueEvent[]>(
      `WITH reminder_windows(window_key, label, lead_time, floor_time) AS (
         VALUES ('1w', 'starts in about a week', interval '7 days', interval '1 day'),
                ('1d', 'starts tomorrow', interval '1 day', interval '0')
       )
       SELECT e.id::text AS id, e.name, w.label, w.window_key AS window,
              -- The banner as an image: a video banner has its poster frame,
              -- and a linked (external) one has nothing to show.
              COALESCE(m.thumbnail_filename,
                       CASE WHEN m.mime_type LIKE 'image/%' THEN m.filename END
              ) AS banner_filename
         FROM public.events e
    LEFT JOIN public.event_media m ON m.id = e.banner_media_id
         CROSS JOIN reminder_windows w
        WHERE e.starts_at IS NOT NULL
          AND e.starts_at > now() + w.floor_time
          AND e.starts_at <= now() + w.lead_time
          AND NOT EXISTS (
            SELECT 1 FROM public.notifications n
             WHERE n.type = 'EventReminder'
               AND n.entity_id = e.id::text || ':' || w.window_key
          )`,
    );

    let sent = 0;
    for (const event of due) {
      const attendees = await this.postgres.query<Array<{ steam_id: string }>>(
        `SELECT DISTINCT steam_id::text AS steam_id FROM (
                 SELECT steam_id FROM public.event_players WHERE event_id = $1::uuid
                  UNION
                 SELECT steam_id FROM public.event_organizers WHERE event_id = $1::uuid
               ) attending`,
        [event.id],
      );

      if (attendees.length === 0) {
        continue;
      }

      await this.notifications.notifyPlayers("EventReminder", {
        title: "Event Starting Soon",
        message: `<a href="/events/${event.id}"><b>${NotificationsService.escapeHtml(
          event.name,
        )}</b></a> ${event.label}.`,
        role: "user",
        entity_id: `${event.id}:${event.window}`,
        steamIds: attendees.map((attendee) => attendee.steam_id),
        ...(event.banner_filename
          ? {
              data: {
                image: `/events/media/${event.id}/${event.banner_filename}`,
              },
            }
          : {}),
      });

      sent++;
    }

    return sent;
  }

  // A season ends by its own clock rather than through an action, so there is
  // no call site to hang this off -- it has to be noticed.
  private async announceEndedSeasons(): Promise<number> {
    const ended = await this.postgres.query<EndedSeason[]>(
      `SELECT s.id::text AS id, s.number::text AS number
         FROM public.seasons s
        WHERE s.ends_at IS NOT NULL
          AND s.ends_at <= now()
          -- Only just ended. Without this every historical season announces
          -- itself the first time this job runs.
          AND s.ends_at > now() - interval '1 day'
          AND NOT EXISTS (
            SELECT 1 FROM public.notifications n
             WHERE n.type = 'SeasonEnded'
               AND n.entity_id = s.id::text
          )`,
    );

    let sent = 0;
    for (const season of ended) {
      const label = season.number ? `Season ${season.number}` : "The season";

      await this.notifications.notifyActivePlayers("SeasonEnded", {
        title: "Season Ended",
        message: `<a href="/seasons"><b>${NotificationsService.escapeHtml(
          label,
        )}</b></a> has ended. See where you finished.`,
        entity_id: season.id,
      });

      sent++;
    }

    if (sent > 0) {
      this.logger.log(`${sent} season-ended announcements sent`);
    }

    return sent;
  }
}
