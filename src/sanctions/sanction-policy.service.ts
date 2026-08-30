import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";

export type SanctionSource = "match_abandon" | "vac_ban" | "tournament_no_show";

export type SanctionScope = "matchmaking" | "tournaments" | "both";

export type SanctionPolicy = {
  source: string;
  enabled: boolean;
  threshold: number;
  windowDays: number;
  durations: Array<number>;
  scope: SanctionScope;
  writesPlatformBan: boolean;
};

// Reads and applies the configurable sanctions policy. The policy itself lives
// in `public.settings` and is resolved by the SQL in
// hasura/functions/sanctions/sanction_policy.sql -- this service never keeps a
// second copy of a threshold or a duration, it only asks.
@Injectable()
export class SanctionPolicyService {
  public static readonly SETTING_PREFIX = "public.sanction_";

  public static readonly FIELDS = [
    "enabled",
    "threshold",
    "window_days",
    "durations",
    "scope",
  ] as const;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {}

  public static settingName(
    source: string,
    field: (typeof SanctionPolicyService.FIELDS)[number],
  ): string {
    return `${SanctionPolicyService.SETTING_PREFIX}${source}_${field}`;
  }

  public async getPolicies(): Promise<Array<SanctionPolicy>> {
    const rows = await this.postgres.query<
      Array<{
        source: string;
        enabled: boolean;
        threshold: number;
        window_days: number;
        durations: Array<number>;
        scope: SanctionScope;
        writes_platform_ban: boolean;
      }>
    >(
      `SELECT src.value AS source,
              public.sanction_policy_enabled(src.value) AS enabled,
              public.sanction_policy_threshold(src.value) AS threshold,
              public.sanction_policy_window_days(src.value) AS window_days,
              public.sanction_policy_durations(src.value) AS durations,
              public.sanction_policy_scope(src.value) AS scope,
              src.writes_platform_ban
         FROM public.e_sanction_sources src
        ORDER BY src.value`,
    );

    return rows.map((row) => ({
      source: row.source,
      enabled: row.enabled,
      threshold: row.threshold,
      windowDays: row.window_days,
      durations: row.durations ?? [],
      scope: row.scope,
      writesPlatformBan: row.writes_platform_ban,
    }));
  }

  public async getPolicy(source: string): Promise<SanctionPolicy | undefined> {
    const policies = await this.getPolicies();

    return policies.find((policy) => policy.source === source);
  }

  // The same arithmetic public.sanction_expiry does, for callers that already
  // hold the policy and do not want a round trip. `null` means the policy does
  // not fire; `Infinity` means it never lifts, which player_sanctions spells as
  // a NULL remove_sanction_date.
  public static resolveExpiry(
    policy: SanctionPolicy,
    occurrences: number,
    lastOccurredAt: Date,
  ): Date | number | null {
    if (!policy.enabled) {
      return null;
    }

    if (!Number.isFinite(occurrences) || occurrences < 1) {
      return null;
    }

    if (occurrences < policy.threshold) {
      return null;
    }

    if (policy.durations.length === 0) {
      return null;
    }

    const minutes =
      policy.durations[Math.min(occurrences, policy.durations.length) - 1];

    if (minutes === 0) {
      return Infinity;
    }

    return new Date(lastOccurredAt.getTime() + minutes * 60 * 1000);
  }

  public static covers(policy: SanctionPolicy, scope: SanctionScope): boolean {
    return policy.scope === "both" || policy.scope === scope;
  }

  public async playerSanctionExpiry(
    steamId: string,
    scope: SanctionScope,
  ): Promise<Date | null> {
    const rows = await this.postgres.query<Array<{ expiry: Date | null }>>(
      `SELECT public.player_sanction_expiry($1::bigint, $2) AS expiry`,
      [steamId, scope],
    );

    return rows.at(0)?.expiry ?? null;
  }

  // Called when a tournament's check-in window closes. Records one occurrence
  // per rostered player of every team that missed it, and is safe to call again
  // for the same tournament -- the unique constraint on tournament_no_shows is
  // what stops a second pass from doubling anybody's count.
  public async recordTournamentNoShows(tournamentId: string): Promise<number> {
    try {
      const rows = await this.postgres.query<Array<{ recorded: number }>>(
        `SELECT public.record_tournament_no_shows($1::uuid) AS recorded`,
        [tournamentId],
      );

      const recorded = rows.at(0)?.recorded ?? 0;

      if (recorded > 0) {
        this.logger.log(
          `recorded ${recorded} tournament no-show(s) for ${tournamentId}`,
        );
      }

      return recorded;
    } catch (error) {
      // Holding the tournament for review is what actually matters; never lose
      // that because the bookkeeping behind a future ban failed.
      this.logger.warn(
        `unable to record tournament no-shows for ${tournamentId}`,
        error,
      );

      return 0;
    }
  }
}
