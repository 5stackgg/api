import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchJobs } from "../enums/MatchJobs";
import { PostgresService } from "../../postgres/postgres.service";
import { wakeJobAt } from "../../utilities/QueueProcessors";
import { CheckForScheduledMatches } from "../jobs/CheckForScheduledMatches";
import { CancelExpiredMatches } from "../jobs/CancelExpiredMatches";
import { CheckForScheduledTournamentBrackets } from "../jobs/CheckForScheduledTournamentBrackets";
import { ProcessTournamentCheckIn } from "../jobs/ProcessTournamentCheckIn";
import { CheckForTournamentStart } from "../jobs/CheckForTournamentStart";
import { CancelInvalidTournaments } from "../jobs/CancelInvalidTournaments";

type MatchDeadlines = {
  id: string;
  status: string;
  scheduled_at: Date | null;
  cancels_at: Date | null;
  veto_pick_expires_at: Date | null;
};

type TournamentDeadlines = {
  id: string;
  status: string;
  start: Date | null;
  check_in_required: boolean;
  check_in_opens_before_minutes: number;
  check_in_ends_at: Date | null;
};

type BracketDeadline = {
  scheduled_at: Date | null;
};

const MINUTE_MS = 60 * 1000;

// Postgres owns every deadline. This only wakes the sweep that acts on one at
// that moment, rather than leaving it to the sweep's next scheduled pass.
@Injectable()
export class DeadlinesService {
  public static readonly SWEEPS = [
    CheckForScheduledMatches.name,
    CancelExpiredMatches.name,
    CheckForScheduledTournamentBrackets.name,
    ProcessTournamentCheckIn.name,
    CheckForTournamentStart.name,
    CancelInvalidTournaments.name,
  ];

  // Past the next reconcile, which runs every 5 minutes, so a wake-up that was
  // never armed is armed before it is due.
  public static readonly LOOKAHEAD_MS = 10 * MINUTE_MS;

  // CheckForScheduledMatches holds a tournament's pre-start matches until a
  // minute past its start, so that moment needs a wake-up of its own.
  private static readonly PRE_START_HOLD_MS = 61 * 1000;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    @InjectQueue(MatchQueues.Deadlines) private readonly queue: Queue,
    @InjectQueue(MatchQueues.VetoTimeouts) private readonly vetoQueue: Queue,
  ) {}

  public static VetoPickJobPrefix(matchId: string) {
    return `match.${matchId}.veto-pick.`;
  }

  public async armMatch(matchId: string): Promise<MatchDeadlines | undefined> {
    const [match] = await this.postgres.query<Array<MatchDeadlines>>(
      `SELECT id, status, scheduled_at, cancels_at, veto_pick_expires_at
         FROM matches WHERE id = $1`,
      [matchId],
    );

    if (match) {
      await this.armMatchRow(match);
    }

    return match;
  }

  public async armTournament(tournamentId: string): Promise<void> {
    const [tournament] = await this.postgres.query<Array<TournamentDeadlines>>(
      `SELECT id, status, start, check_in_required, check_in_opens_before_minutes, check_in_ends_at
         FROM tournaments WHERE id = $1`,
      [tournamentId],
    );

    if (tournament) {
      await this.armTournamentRow(tournament);
    }
  }

  public async armBracket(bracketId: string): Promise<void> {
    const [bracket] = await this.postgres.query<Array<BracketDeadline>>(
      `SELECT scheduled_at FROM tournament_brackets
        WHERE id = $1 AND match_id IS NULL AND finished = false`,
      [bracketId],
    );

    if (bracket?.scheduled_at) {
      await this.armBracketRow(bracket);
    }
  }

  // The backstop for a wake-up that was never armed or was lost with Redis:
  // every sweep runs now, and anything due before the next pass is armed for
  // its moment.
  public async reconcile(): Promise<void> {
    const now = Date.now();

    for (const sweep of DeadlinesService.SWEEPS) {
      await wakeJobAt(this.queue, sweep, now);
    }
    await wakeJobAt(this.vetoQueue, MatchJobs.AutoPickExpiredVeto, now);

    const lookahead = `${DeadlinesService.LOOKAHEAD_MS} milliseconds`;

    const matches = await this.postgres.query<Array<MatchDeadlines>>(
      `SELECT id, status, scheduled_at, cancels_at, veto_pick_expires_at
         FROM matches
        WHERE (status = 'Scheduled'
               AND scheduled_at > now() + $2::interval
               AND scheduled_at <= now() + $2::interval + $1::interval)
           OR (status <> 'Canceled'
               AND cancels_at > now()
               AND cancels_at <= now() + $1::interval + $3::interval)
           OR (status = 'Veto'
               AND veto_pick_expires_at > now()
               AND veto_pick_expires_at <= now() + $1::interval)`,
      [
        lookahead,
        `${CheckForScheduledMatches.LEAD_MS} milliseconds`,
        `${CancelExpiredMatches.FORCE_START_LEAD_MS} milliseconds`,
      ],
    );

    for (const match of matches) {
      await this.armMatchRow(match);

      if (match.status === "Veto" && match.veto_pick_expires_at) {
        await wakeJobAt(
          this.vetoQueue,
          MatchJobs.AutoPickExpiredVeto,
          match.veto_pick_expires_at,
        );
      }
    }

    const tournaments = await this.postgres.query<Array<TournamentDeadlines>>(
      `SELECT id, status, start, check_in_required, check_in_opens_before_minutes, check_in_ends_at
         FROM tournaments
        WHERE status IN ('RegistrationOpen', 'RegistrationClosed', 'CheckInReview')
          AND start + $3::interval > now()
          AND start - make_interval(mins => GREATEST(check_in_opens_before_minutes, $2::int))
              <= now() + $1::interval`,
      [
        lookahead,
        CheckForTournamentStart.LEAD_MS / MINUTE_MS,
        `${DeadlinesService.PRE_START_HOLD_MS} milliseconds`,
      ],
    );

    for (const tournament of tournaments) {
      await this.armTournamentRow(tournament);
    }

    const brackets = await this.postgres.query<Array<BracketDeadline>>(
      `SELECT tb.scheduled_at
         FROM tournament_brackets tb
         INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         INNER JOIN tournaments t ON t.id = ts.tournament_id
        WHERE tb.match_id IS NULL
          AND tb.finished = false
          AND t.status = 'Live'
          AND tb.scheduled_at > now() + $2::interval
          AND tb.scheduled_at <= now() + $2::interval + $1::interval`,
      [
        lookahead,
        `${CheckForScheduledTournamentBrackets.LEAD_MS} milliseconds`,
      ],
    );

    for (const bracket of brackets) {
      await this.armBracketRow(bracket);
    }
  }

  /**
   * Mirrors matches.veto_pick_expires_at onto a delayed job that fires at
   * exactly that moment. Passing null just cancels.
   */
  public async scheduleVetoPickTimeout(
    matchId: string,
    expiresAt: Date | string | null,
  ) {
    await this.removeVetoPickTimeout(matchId);

    if (!expiresAt) {
      return;
    }

    const [{ pick_count }] = await this.postgres.query<
      Array<{ pick_count: number }>
    >("SELECT veto_pick_count($1) AS pick_count", [matchId]);

    await this.vetoQueue.add(
      MatchJobs.AutoPickExpiredVeto,
      {
        matchId,
        pickCount: pick_count,
      },
      {
        // Floored at 0 so an event we picked up late fires immediately rather
        // than being rejected for a negative delay.
        delay: Math.max(0, new Date(expiresAt).getTime() - Date.now()),
        // The pick count fences a retry off a turn that has moved on.
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnFail: true,
        removeOnComplete: true,
        jobId: `${DeadlinesService.VetoPickJobPrefix(matchId)}${pick_count}`,
      },
    );
  }

  public async removeVetoPickTimeout(matchId: string) {
    const prefix = DeadlinesService.VetoPickJobPrefix(matchId);

    try {
      for (const job of await this.vetoQueue.getDelayed()) {
        if (job.id?.startsWith(prefix)) {
          await job.remove();
        }
      }
    } catch {
      this.logger.debug(`[${matchId}] no veto pick timers to remove`);
    }
  }

  private async armMatchRow(match: MatchDeadlines) {
    if (match.status === "Scheduled" && match.scheduled_at) {
      await this.wake(
        CheckForScheduledMatches.name,
        match.scheduled_at.getTime() - CheckForScheduledMatches.LEAD_MS,
      );
    }

    if (match.cancels_at && match.status !== "Canceled") {
      await this.wake(
        CancelExpiredMatches.name,
        match.cancels_at.getTime() - CancelExpiredMatches.FORCE_START_LEAD_MS,
      );
      await this.wake(CancelExpiredMatches.name, match.cancels_at.getTime());
    }
  }

  // Every moment any of the tournament sweeps acts at. They each re-check the
  // status themselves, so waking one that has nothing to do costs a query.
  private async armTournamentRow(tournament: TournamentDeadlines) {
    if (tournament.status === "Live") {
      await this.wake(CheckForScheduledTournamentBrackets.name, Date.now());
    }

    if (!tournament.start) {
      return;
    }

    const start = tournament.start.getTime();

    await this.wake(
      CheckForTournamentStart.name,
      start - CheckForTournamentStart.LEAD_MS,
    );
    await this.wake(CheckForTournamentStart.name, start);
    await this.wake(CancelInvalidTournaments.name, start);
    await this.wake(
      CheckForScheduledMatches.name,
      start + DeadlinesService.PRE_START_HOLD_MS,
    );

    if (!tournament.check_in_required) {
      return;
    }

    await this.wake(
      ProcessTournamentCheckIn.name,
      start - tournament.check_in_opens_before_minutes * MINUTE_MS,
    );
    await this.wake(ProcessTournamentCheckIn.name, start);

    if (tournament.check_in_ends_at) {
      const endsAt = tournament.check_in_ends_at.getTime();

      await this.wake(
        ProcessTournamentCheckIn.name,
        endsAt - ProcessTournamentCheckIn.CLOSING_REMINDER_MINUTES * MINUTE_MS,
      );
      await this.wake(ProcessTournamentCheckIn.name, endsAt);
    }
  }

  private async armBracketRow(bracket: BracketDeadline) {
    await this.wake(
      CheckForScheduledTournamentBrackets.name,
      bracket.scheduled_at.getTime() -
        CheckForScheduledTournamentBrackets.LEAD_MS,
    );
  }

  private async wake(sweep: string, at: number) {
    await wakeJobAt(this.queue, sweep, at);
  }
}
