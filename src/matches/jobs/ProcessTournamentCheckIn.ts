import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { NotificationsService } from "../../notifications/notifications.service";

type CheckInTournament = {
  id: string;
  name: string;
  banner: string | null;
  logo: string | null;
};

type OpenedTournament = CheckInTournament & {
  notify: boolean;
};

type ClosingTournament = CheckInTournament & {
  entity_id: string;
};

type ClosedTournament = CheckInTournament & {
  status: string;
  organizer_steam_id: string | null;
};

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ProcessTournamentCheckIn extends WorkerHost {
  // The window is at least 5 minutes wide (a CHECK constraint on the
  // tournament), so anything longer than this would fire the reminder at the
  // same moment as the "check-in is open" notice on the tightest setup.
  private static readonly CLOSING_REMINDER_MINUTES = 5;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(): Promise<number> {
    let handled = 0;

    handled += await this.openCheckInWindows();
    handled += await this.remindBeforeCutoff();
    handled += await this.closeCheckInWindows();
    handled += await this.releaseHeldTournaments();

    return handled;
  }

  // Stamping check_in_ends_at is what opens the window: the deadline is frozen
  // there so a later schedule edit cannot drag it, and check_in_ends_at IS NULL
  // is the fence that keeps this pass from re-opening the same tournament.
  private async openCheckInWindows(): Promise<number> {
    const opened = await this.postgres.query<Array<OpenedTournament>>(
      `UPDATE tournaments t
          SET check_in_ends_at = t."start" - make_interval(mins => t.check_in_closes_before_minutes)
        WHERE t.check_in_required
          AND t.status = 'RegistrationOpen'
          AND t.check_in_ends_at IS NULL
          AND now() >= t."start" - make_interval(mins => t.check_in_opens_before_minutes)
       RETURNING t.id::text AS id, t.name, t.banner, t.logo,
                 t.check_in_ends_at > now() AS notify`,
    );

    for (const tournament of opened) {
      // A tournament whose whole window elapsed while this job was down still
      // gets its deadline stamped -- the close pass below needs it -- but
      // announcing a window that is already over would only be noise.
      if (!tournament.notify) {
        continue;
      }

      await this.notifyPending(
        tournament,
        "TournamentCheckInOpen",
        "Tournament check-in is open",
        "check-in is open. Confirm your spot before the deadline.",
        tournament.id,
      );
    }

    if (opened.length > 0) {
      this.logger.log(`${opened.length} tournament check-in windows opened`);
    }

    return opened.length;
  }

  // Deduped the way TournamentReminders dedupes its own windows: a distinct
  // entity_id makes a NOT EXISTS check enough with no extra state on the
  // tournament. The deadline is part of the key so an organizer extending the
  // window earns a fresh reminder rather than silence.
  private async remindBeforeCutoff(): Promise<number> {
    const due = await this.postgres.query<Array<ClosingTournament>>(
      `SELECT t.id::text AS id, t.name, t.banner, t.logo,
              t.id::text || ':closing:' || extract(epoch from t.check_in_ends_at)::bigint::text AS entity_id
         FROM tournaments t
        WHERE t.check_in_required
          AND t.status = 'RegistrationOpen'
          AND t.check_in_ends_at IS NOT NULL
          AND t.check_in_ends_at > now()
          AND t.check_in_ends_at <= now() + make_interval(mins => $1::int)
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.type = 'TournamentCheckInClosing'
               AND n.entity_id = t.id::text || ':closing:' || extract(epoch from t.check_in_ends_at)::bigint::text
          )`,
      [ProcessTournamentCheckIn.CLOSING_REMINDER_MINUTES],
    );

    let sent = 0;
    for (const tournament of due) {
      const notified = await this.notifyPending(
        tournament,
        "TournamentCheckInClosing",
        "Tournament check-in closing",
        "check-in closes in a few minutes.",
        tournament.entity_id,
      );

      if (notified) {
        sent++;
      }
    }

    return sent;
  }

  private async closeCheckInWindows(): Promise<number> {
    // Before the flip, not after: a flip to RegistrationClosed runs the
    // free-agent draft, and the draft's pool would otherwise include the very
    // players who never confirmed. A waitlisted no-show who confirms during an
    // extension is picked back up, because the pool re-admits waitlisted
    // agents that have checked in.
    await this.postgres.query(
      `UPDATE tournament_free_agents fa
          SET status = 'waitlisted'
         FROM tournaments t
        WHERE t.id = fa.tournament_id
          AND t.check_in_required
          AND t.status = 'RegistrationOpen'
          AND t.check_in_ends_at IS NOT NULL
          AND t.check_in_ends_at <= now()
          AND fa.status = 'registered'
          AND fa.checked_in_at IS NULL`,
    );

    // One statement decides the destination and claims the tournament: a manual
    // "Close Registration" click racing this tick loses the WHERE and neither
    // side acts twice.
    const closed = await this.postgres.query<Array<ClosedTournament>>(
      `UPDATE tournaments t
          SET status = CASE
              WHEN EXISTS (
                  SELECT 1 FROM tournament_teams tt
                   WHERE tt.tournament_id = t.id
                     AND tt.checked_in_at IS NULL
              ) THEN 'CheckInReview'
              ELSE 'RegistrationClosed'
          END
        WHERE t.check_in_required
          AND t.status = 'RegistrationOpen'
          AND t.check_in_ends_at IS NOT NULL
          AND t.check_in_ends_at <= now()
       RETURNING t.id::text AS id, t.name, t.banner, t.logo, t.status,
                 t.organizer_steam_id::text AS organizer_steam_id`,
    );

    for (const tournament of closed) {
      if (tournament.status !== "CheckInReview") {
        continue;
      }

      const recipients = await this.pendingRecipients(tournament.id);

      if (tournament.organizer_steam_id) {
        recipients.push(tournament.organizer_steam_id);
      }

      await this.notify(
        tournament,
        "TournamentCheckInMissed",
        "Tournament check-in missed",
        "check-in closed with teams missing. The organizer is reviewing.",
        tournament.id,
        recipients,
      );
    }

    if (closed.length > 0) {
      this.logger.log(`${closed.length} tournament check-in windows closed`);
    }

    return closed.length;
  }

  // A tournament held for review must never die because nobody was watching.
  // The write carries no hasura.user, which every can_* guard treats as an
  // internal write, so the CheckInReview exit is allowed without an organizer.
  private async releaseHeldTournaments(): Promise<number> {
    const released = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE tournaments t
          SET status = 'RegistrationClosed'
        WHERE t.status = 'CheckInReview'
          AND now() >= t."start"
       RETURNING t.id::text AS id`,
    );

    if (released.length > 0) {
      this.logger.log(
        `${released.length} tournaments continued out of check-in review`,
      );
    }

    return released.length;
  }

  // Everyone who still owes a confirmation: rostered players (per-player in
  // Players mode, whole roster otherwise), the team owner even when they are
  // not on the roster, and free agents who registered on their own.
  private async pendingRecipients(
    tournamentId: string,
  ): Promise<Array<string>> {
    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT steam_id::text AS steam_id FROM (
              SELECT ttr.player_steam_id AS steam_id
                FROM tournament_team_roster ttr
                JOIN tournament_teams tt ON tt.id = ttr.tournament_team_id
                JOIN tournaments t ON t.id = tt.tournament_id
               WHERE tt.tournament_id = $1::uuid
                 AND tt.checked_in_at IS NULL
                 AND (t.check_in_setting <> 'Players' OR ttr.checked_in_at IS NULL)
              UNION
              SELECT tt.owner_steam_id AS steam_id
                FROM tournament_teams tt
               WHERE tt.tournament_id = $1::uuid
                 AND tt.checked_in_at IS NULL
                 AND tt.owner_steam_id IS NOT NULL
              UNION
              SELECT fa.player_steam_id AS steam_id
                FROM tournament_free_agents fa
               WHERE fa.tournament_id = $1::uuid
                 AND fa.checked_in_at IS NULL
                 AND fa.status IN ('registered', 'waitlisted')
            ) pending`,
      [tournamentId],
    );

    return rows.map((row) => row.steam_id);
  }

  private async notifyPending(
    tournament: CheckInTournament,
    type: "TournamentCheckInOpen" | "TournamentCheckInClosing",
    title: string,
    body: string,
    entityId: string,
  ): Promise<boolean> {
    const recipients = await this.pendingRecipients(tournament.id);

    return this.notify(tournament, type, title, body, entityId, recipients);
  }

  private async notify(
    tournament: CheckInTournament,
    type:
      | "TournamentCheckInOpen"
      | "TournamentCheckInClosing"
      | "TournamentCheckInMissed",
    title: string,
    body: string,
    entityId: string,
    recipients: Array<string>,
  ): Promise<boolean> {
    if (recipients.length === 0) {
      return false;
    }

    await this.notifications.notifyPlayers(type, {
      title,
      message: `<a href="/tournaments/${tournament.id}"><b>${NotificationsService.escapeHtml(
        tournament.name,
      )}</b></a> ${body}`,
      role: "user",
      entity_id: entityId,
      steamIds: recipients,
      data: { image: tournament.banner ?? tournament.logo },
    });

    return true;
  }
}
