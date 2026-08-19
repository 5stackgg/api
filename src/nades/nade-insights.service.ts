import { Injectable } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { NadeLineupsService } from "./nade-lineups.service";

export type NadePracticePlanEntry = {
  nade_lineup_id: string;
  priority: number;
  meta_throwers: number;
  attempts: number;
  successes: number;
  mastered: boolean;
  reason: string;
  // What everybody else's practice says about the lineup, as opposed to
  // attempts/successes above, which are the caller's own.
  difficulty: string;
  global_players: number;
  global_attempts: number;
  // Null whenever difficulty is 'unmeasured': a rate off four throws is a
  // number the UI would render as if it meant something.
  global_landing_rate: number | null;
};

export type NadePracticePlanOutput = {
  analysed: boolean;
  message: string | null;
  entries: Array<NadePracticePlanEntry>;
};

export type NadeMissPatternOutput = {
  analysed: boolean;
  message: string | null;
  samples: number;
  players: number;
  mean_along: number | null;
  mean_lateral: number | null;
  mean_vertical: number | null;
  bias: string | null;
};

export type NadeTeamUtilityEntry = {
  nade_lineup_id: string;
  thrown: number;
  landed: number;
  players: number;
};

export type NadeTeamUtilityOutput = {
  analysed: boolean;
  message: string | null;
  entries: Array<NadeTeamUtilityEntry>;
};

type PlanCandidate = {
  nade_lineup_id: string;
  meta_throwers: number;
  attempts: number;
  successes: number;
  mastered: boolean;
  current_streak: number;
  difficulty: string;
  global_players: number;
  global_attempts: number;
  global_successes: number;
};

type MissSample = {
  samples: number;
  along: number;
  lateral: number;
  vertical: number;
};

// The two questions the mined data can answer that a browse cannot: what this
// player should drill next, and what a team's utility actually did in matches.
//
// Both are aggregates by construction. nade_demo_throws names players and is
// admin-only for that reason, so nothing here ever returns a row out of it --
// only counts over it.
@Injectable()
export class NadeInsightsService {
  // Distinct throwers at which a bucket stops being one player's habit and
  // starts being something the map expects you to know.
  public static readonly POPULAR_THROWERS = 5;

  public static readonly DEFAULT_PLAN_LIMIT = 20;
  public static readonly MAX_PLAN_LIMIT = 100;
  // Ranking happens after the rows are read, so the query has to bring back
  // more than it will return without bringing back a map's entire library.
  private static readonly PLAN_CANDIDATES = 500;

  public static readonly DEFAULT_REPORT_LIMIT = 25;
  public static readonly MAX_REPORT_LIMIT = 100;

  // Reason tokens. Short, stable, and machine-readable on purpose: the copy
  // that goes next to them is the web app's to write and to translate.
  public static readonly NEVER_ATTEMPTED = "never_attempted";
  public static readonly POPULAR_UNMASTERED = "popular_unmastered";
  public static readonly UNMASTERED = "unmastered";
  public static readonly MASTERED_SLIPPING = "mastered_slipping";

  // Difficulty tokens. The thresholds behind them live in
  // public.nade_lineup_difficulty, which is the single definition -- the
  // computed field on the lineup and the plan below both read it from there,
  // so nothing here can drift away from what the library shows.
  public static readonly UNMEASURED = "unmeasured";
  public static readonly EASY = "easy";
  public static readonly MODERATE = "moderate";
  public static readonly HARD = "hard";
  public static readonly VERY_HARD = "very_hard";

  // How the plan is ordered. A new option rather than a new default: the
  // existing ranking is what every caller already gets, and difficulty is a
  // different question -- "what is worth the most" against "what can I have
  // by the end of this session".
  public static readonly ORDER_PRIORITY = "priority";
  public static readonly ORDER_QUICK_WINS = "quick_wins";
  public static readonly ORDER_PROJECTS = "projects";

  private static readonly DIFFICULTY_ORDER = [
    NadeInsightsService.EASY,
    NadeInsightsService.MODERATE,
    NadeInsightsService.HARD,
    NadeInsightsService.VERY_HARD,
  ];

  // Bias tokens. Short and machine-readable for the same reason the reasons
  // above are: the copy next to them is the web app's to write.
  public static readonly BIAS_NONE = "none";
  public static readonly BIAS_SCATTERED = "scattered";
  public static readonly BIAS_SHORT = "short";
  public static readonly BIAS_LONG = "long";
  public static readonly BIAS_LEFT = "left";
  public static readonly BIAS_RIGHT = "right";
  public static readonly BIAS_LOW = "low";
  public static readonly BIAS_HIGH = "high";

  // A confident "you undershoot this" off three throws is worse than saying
  // nothing, so there are two floors and both have to clear. Distinct players
  // is the one that matters: twenty throws is one person's afternoon, and one
  // person's habit is not the lineup's pattern. Three is the same bar
  // public.nade_verify_masteries defaults to for calling a lineup verified.
  public static readonly MIN_PATTERN_PLAYERS = 3;
  public static readonly MIN_PATTERN_SAMPLES = 20;
  // Fraction of the success radius a mean offset has to reach before it is a
  // bias rather than the spread a grenade has anyway. A quarter of the default
  // 96 is 24 units -- well inside the cloud, and not worth telling anybody to
  // change their aim over.
  private static readonly BIAS_FLOOR_RATIO = 0.25;
  // How far the bias has to stand out of the disagreement between players
  // before it is the lineup's pattern rather than theirs. Below it the players
  // are missing in different directions and the mean is an artefact of
  // averaging them.
  private static readonly BIAS_SIGNAL_RATIO = 0.75;

  constructor(
    private readonly postgres: PostgresService,
    private readonly lineups: NadeLineupsService,
  ) {}

  // What to learn next: the difference between what people throw on this map
  // (nade_meta_lineups.throwers, mined out of real demos) and what the caller
  // has actually drilled (nade_lineup_progress).
  public async practicePlan(
    user: User,
    input: {
      map_name: string;
      side?: string | null;
      limit?: number | null;
      order?: string | null;
    },
  ): Promise<NadePracticePlanOutput> {
    const mapName = String(input.map_name ?? "").trim();

    if (!mapName) {
      throw Error("map_name is required");
    }

    const order = NadeInsightsService.order(input.order);
    const side = NadeInsightsService.text(input.side);
    const limit = NadeInsightsService.clamp(
      input.limit,
      NadeInsightsService.DEFAULT_PLAN_LIMIT,
      NadeInsightsService.MAX_PLAN_LIMIT,
    );

    // Asked separately so an un-mined map answers "there is nothing to compare
    // you against" rather than an empty list, which reads as "nothing to learn"
    // -- the opposite of the truth on a map nobody has mined yet.
    const [meta] = await this.postgres.query<Array<{ mined: boolean }>>(
      `SELECT EXISTS (
                SELECT 1 FROM public.nade_meta_lineups m WHERE m.map_name = $1
              ) AS mined`,
      [mapName],
    );

    if (!meta?.mined) {
      return {
        analysed: false,
        message:
          "no demos on this map have been mined yet, so there is no meta to compare your practice against",
        entries: [],
      };
    }

    // DISTINCT ON the bucket: a popular spot can hold a dozen saved write-ups of
    // the same throw, and a plan that lists all twelve is not a plan. The one
    // kept is whichever the caller is already drilling, then a verified one,
    // then the best-voted.
    const candidates = await this.postgres.query<Array<PlanCandidate>>(
      `SELECT DISTINCT ON (m.lineup_bucket)
              l.id::text AS nade_lineup_id,
              m.throwers::int AS meta_throwers,
              COALESCE(p.attempts, 0)::int AS attempts,
              COALESCE(p.successes, 0)::int AS successes,
              (p.mastered_at IS NOT NULL) AS mastered,
              COALESCE(p.current_streak, 0)::int AS current_streak,
              public.nade_lineup_difficulty(l) AS difficulty,
              l.practice_players::int AS global_players,
              l.practice_attempts::int AS global_attempts,
              l.practice_successes::int AS global_successes
         FROM public.nade_meta_lineups m
         INNER JOIN public.nade_lineups l
                 ON l.lineup_bucket = m.lineup_bucket
         LEFT JOIN public.nade_lineup_progress p
                ON p.nade_lineup_id = l.id
               AND p.steam_id = $2::bigint
        WHERE m.map_name = $1
          AND l.archived_at IS NULL
          AND ($3::text IS NULL OR l.side = $3::text)
          AND public.can_view_nade_lineup(l, $4::json)
        ORDER BY m.lineup_bucket,
                 (p.nade_lineup_id IS NOT NULL) DESC,
                 (l.verified_at IS NOT NULL) DESC,
                 l.upvotes DESC,
                 l.created_at ASC
        LIMIT ${NadeInsightsService.PLAN_CANDIDATES}`,
      [mapName, user.steam_id, side, NadeInsightsService.session(user)],
    );

    const entries = candidates
      .map((candidate) => NadeInsightsService.rank(candidate))
      .filter((entry): entry is NadePracticePlanEntry => entry !== null)
      .sort((a, b) => NadeInsightsService.compare(a, b, order))
      .slice(0, limit);

    return {
      analysed: true,
      message:
        entries.length > 0
          ? null
          : candidates.length > 0
            ? "every lineup you can see on this map that the meta throws is already mastered"
            : "no lineup you can see on this map falls in a bucket the meta has thrown yet",
      entries,
    };
  }

  // Rank is popularity discounted by how much of it the caller already owns. A
  // lineup they have mastered and are still hitting drops out entirely -- the
  // question is what to learn next, and that one is learned.
  private static rank(candidate: PlanCandidate): NadePracticePlanEntry | null {
    const attempts = Number(candidate.attempts);
    const successes = Number(candidate.successes);
    const throwers = Number(candidate.meta_throwers);

    const gap = candidate.mastered
      ? // A streak reset means they have missed it since. Worth revisiting, but
        // never worth as much as a throw they have never landed.
        candidate.current_streak === 0
        ? 0.35
        : 0
      : attempts === 0
        ? 1
        : // Floored rather than allowed to reach zero: five in a row is the bar,
          // and a good hit rate that has never strung five together is exactly
          // the lineup worth another session.
          Math.max(0.25, 1 - successes / attempts);

    if (gap <= 0) {
      return null;
    }

    const globalAttempts = Number(candidate.global_attempts);
    const measured = candidate.difficulty !== NadeInsightsService.UNMEASURED;

    return {
      nade_lineup_id: candidate.nade_lineup_id,
      priority: Math.round(throwers * gap * 1000) / 1000,
      meta_throwers: throwers,
      attempts,
      successes,
      mastered: candidate.mastered,
      reason: NadeInsightsService.reason(candidate, throwers, attempts),
      difficulty: candidate.difficulty,
      global_players: Number(candidate.global_players),
      global_attempts: globalAttempts,
      global_landing_rate:
        measured && globalAttempts > 0
          ? Math.round(
              (Number(candidate.global_successes) / globalAttempts) * 1000,
            ) / 1000
          : null,
    };
  }

  // The existing ranking is the default and is untouched. The two
  // difficulty-aware orders share one rule about the unknown: an unmeasured
  // lineup is not an easy one and it is not a hard one, so it forms its own
  // band behind everything that has been measured rather than being sorted
  // among them at whatever rank a made-up rate would give it.
  private static compare(
    a: NadePracticePlanEntry,
    b: NadePracticePlanEntry,
    order: string,
  ): number {
    if (order !== NadeInsightsService.ORDER_PRIORITY) {
      const band =
        NadeInsightsService.band(a.difficulty) -
        NadeInsightsService.band(b.difficulty);

      if (band !== 0) {
        return band;
      }

      const rank =
        NadeInsightsService.DIFFICULTY_ORDER.indexOf(a.difficulty) -
        NadeInsightsService.DIFFICULTY_ORDER.indexOf(b.difficulty);

      if (rank !== 0) {
        return order === NadeInsightsService.ORDER_QUICK_WINS ? rank : -rank;
      }
    }

    return (
      b.priority - a.priority ||
      b.meta_throwers - a.meta_throwers ||
      a.nade_lineup_id.localeCompare(b.nade_lineup_id)
    );
  }

  private static band(difficulty: string): number {
    return difficulty === NadeInsightsService.UNMEASURED ? 1 : 0;
  }

  private static order(value: unknown): string {
    const order =
      NadeInsightsService.text(value) ?? NadeInsightsService.ORDER_PRIORITY;

    if (
      order !== NadeInsightsService.ORDER_PRIORITY &&
      order !== NadeInsightsService.ORDER_QUICK_WINS &&
      order !== NadeInsightsService.ORDER_PROJECTS
    ) {
      throw Error("unknown order");
    }

    return order;
  }

  private static reason(
    candidate: PlanCandidate,
    throwers: number,
    attempts: number,
  ): string {
    if (candidate.mastered) {
      return NadeInsightsService.MASTERED_SLIPPING;
    }

    if (attempts === 0) {
      return NadeInsightsService.NEVER_ATTEMPTED;
    }

    if (throwers >= NadeInsightsService.POPULAR_THROWERS) {
      return NadeInsightsService.POPULAR_UNMASTERED;
    }

    return NadeInsightsService.UNMASTERED;
  }

  // Where everybody's throws at one lineup actually land, relative to the
  // throw itself. The offsets were decomposed and accumulated at scoring time
  // (NadeLineupsService.decomposeMiss), so this is arithmetic over one row per
  // player and never touches a per-throw record, because there is not one.
  //
  // A mean of player means rather than a mean of throws, which is the entire
  // reason the sums live on nade_lineup_progress. Somebody who drills a lineup
  // two hundred times has a habit; the library must not hand that habit to
  // everybody else as the lineup's pattern.
  public async missPattern(
    user: User,
    input: { nade_lineup_id: string },
  ): Promise<NadeMissPatternOutput> {
    const lineupId = String(input.nade_lineup_id ?? "");

    if (!NadeInsightsService.UUID.test(lineupId)) {
      throw Error("lineup not found");
    }

    const [lineup] = await this.postgres.query<Array<{ visible: boolean }>>(
      `SELECT public.can_view_nade_lineup(l, $2::json) AS visible
         FROM public.nade_lineups l
        WHERE l.id = $1::uuid`,
      [lineupId, NadeInsightsService.session(user)],
    );

    if (!lineup?.visible) {
      throw Error("lineup not found");
    }

    const rows = await this.postgres.query<Array<MissSample>>(
      `SELECT p.miss_samples::int AS samples,
              p.miss_along_sum AS along,
              p.miss_lateral_sum AS lateral,
              p.miss_vertical_sum AS vertical
         FROM public.nade_lineup_progress p
        WHERE p.nade_lineup_id = $1::uuid
          AND p.miss_samples > 0`,
      [lineupId],
    );

    const players = rows.length;
    const samples = rows.reduce((total, row) => total + Number(row.samples), 0);

    if (
      players < NadeInsightsService.MIN_PATTERN_PLAYERS ||
      samples < NadeInsightsService.MIN_PATTERN_SAMPLES
    ) {
      return {
        analysed: false,
        message: `not enough practice on this lineup to read a pattern yet -- it takes ${NadeInsightsService.MIN_PATTERN_SAMPLES} throws by ${NadeInsightsService.MIN_PATTERN_PLAYERS} players`,
        samples,
        players,
        mean_along: null,
        mean_lateral: null,
        mean_vertical: null,
        bias: null,
      };
    }

    const along = rows.map((row) => Number(row.along) / Number(row.samples));
    const lateral = rows.map(
      (row) => Number(row.lateral) / Number(row.samples),
    );
    const vertical = rows.map(
      (row) => Number(row.vertical) / Number(row.samples),
    );
    const radius = await this.lineups.successRadius();

    return {
      analysed: true,
      message: null,
      samples,
      players,
      mean_along: NadeInsightsService.round(NadeInsightsService.mean(along)),
      mean_lateral: NadeInsightsService.round(
        NadeInsightsService.mean(lateral),
      ),
      mean_vertical: NadeInsightsService.round(
        NadeInsightsService.mean(vertical),
      ),
      bias: NadeInsightsService.bias({ along, lateral, vertical }, radius),
    };
  }

  // One token for the axis the miss is worst on, because a player can only act
  // on one correction at a time and "you are 60 short and 8 right" is a way of
  // saying "aim higher" that makes them think about the 8.
  private static bias(
    axes: {
      along: Array<number>;
      lateral: Array<number>;
      vertical: Array<number>;
    },
    radius: number,
  ): string {
    const candidates = [
      {
        values: axes.along,
        low: NadeInsightsService.BIAS_SHORT,
        high: NadeInsightsService.BIAS_LONG,
      },
      {
        values: axes.lateral,
        low: NadeInsightsService.BIAS_LEFT,
        high: NadeInsightsService.BIAS_RIGHT,
      },
      {
        values: axes.vertical,
        low: NadeInsightsService.BIAS_LOW,
        high: NadeInsightsService.BIAS_HIGH,
      },
    ].map((axis) => ({
      ...axis,
      mean: NadeInsightsService.mean(axis.values),
    }));

    const dominant = candidates.reduce((worst, axis) =>
      Math.abs(axis.mean) > Math.abs(worst.mean) ? axis : worst,
    );

    if (
      Math.abs(dominant.mean) <
      radius * NadeInsightsService.BIAS_FLOOR_RATIO
    ) {
      return NadeInsightsService.BIAS_NONE;
    }

    // The mean of a group that disagrees is a number nobody in it would
    // recognise: three players landing long and three landing equally short
    // average to a confident nothing. Spread is measured over the player means
    // rather than over the throws, so a player who is wildly inconsistent
    // still only ever moves their own mean.
    if (
      Math.abs(dominant.mean) <
      NadeInsightsService.spread(dominant.values) *
        NadeInsightsService.BIAS_SIGNAL_RATIO
    ) {
      return NadeInsightsService.BIAS_SCATTERED;
    }

    return dominant.mean < 0 ? dominant.low : dominant.high;
  }

  private static mean(values: Array<number>): number {
    return values.reduce((total, value) => total + value, 0) / values.length;
  }

  private static spread(values: Array<number>): number {
    const mean = NadeInsightsService.mean(values);

    return Math.sqrt(
      values.reduce((total, value) => total + (value - mean) ** 2, 0) /
        values.length,
    );
  }

  // The + 0 is what turns -0 back into 0: a mean a hair below zero on the axis
  // nobody misses on would otherwise be reported as "-0".
  private static round(value: number): number {
    return Math.round(value * 10) / 10 + 0;
  }

  // What a team's utility did in real matches, counted out of the mined throws
  // and matched to saved lineups through lineup_bucket.
  //
  // Gated on membership and aggregated in the database. nade_demo_throws is
  // admin-only because a row names a player and the match they threw it in;
  // nothing that leaves here is finer-grained than a count, so a team-mate
  // learns how the team's smokes went without learning who shanked which one.
  public async teamUtilityReport(
    user: User,
    input: {
      team_id: string;
      map_name?: string | null;
      limit?: number | null;
    },
  ): Promise<NadeTeamUtilityOutput> {
    const teamId = String(input.team_id ?? "");

    if (!NadeInsightsService.UUID.test(teamId)) {
      throw Error("team not found");
    }

    await this.assertTeam(user, teamId);

    const mapName = NadeInsightsService.text(input.map_name);
    const limit = NadeInsightsService.clamp(
      input.limit,
      NadeInsightsService.DEFAULT_REPORT_LIMIT,
      NadeInsightsService.MAX_REPORT_LIMIT,
    );
    const radius = await this.lineups.successRadius();

    const entries = await this.postgres.query<
      Array<{
        nade_lineup_id: string;
        thrown: number;
        landed: number;
        players: number;
      }>
    >(
      `WITH roster AS (
         SELECT t.owner_steam_id AS steam_id
           FROM public.teams t
          WHERE t.id = $1::uuid
          UNION
         SELECT tr.player_steam_id
           FROM public.team_roster tr
          WHERE tr.team_id = $1::uuid
       )
       SELECT nearest.id::text AS nade_lineup_id,
              count(*)::int AS thrown,
              count(*) FILTER (WHERE nearest.distance <= $4::float8)::int AS landed,
              count(DISTINCT t.thrower_steam_id)::int AS players
         FROM public.nade_demo_throws t
         INNER JOIN roster r ON r.steam_id = t.thrower_steam_id
         -- One lineup per throw, the nearest landing inside the bucket, so a
         -- bucket holding three write-ups of the same smoke does not count one
         -- grenade three times.
         CROSS JOIN LATERAL (
           SELECT l.id,
                  sqrt(
                    (l.land_x - t.land_x) ^ 2 +
                    (l.land_y - t.land_y) ^ 2 +
                    (l.land_z - t.land_z) ^ 2
                  ) AS distance
             FROM public.nade_lineups l
            WHERE l.lineup_bucket = t.lineup_bucket
              AND l.archived_at IS NULL
              AND public.can_view_nade_lineup(l, $3::json)
            ORDER BY distance ASC
            LIMIT 1
         ) AS nearest
        WHERE ($2::text IS NULL OR t.map_name = $2::text)
        GROUP BY nearest.id
        ORDER BY thrown DESC, landed DESC, nearest.id ASC
        LIMIT $5::int`,
      [teamId, mapName, NadeInsightsService.session(user), radius, limit],
    );

    if (entries.length > 0) {
      return {
        analysed: true,
        message: null,
        entries: entries.map((entry) => ({
          nade_lineup_id: entry.nade_lineup_id,
          thrown: Number(entry.thrown),
          landed: Number(entry.landed),
          players: Number(entry.players),
        })),
      };
    }

    // Empty has two very different causes and they lead somewhere different:
    // wait for the miner, or go and save the lineups your team is throwing.
    const [fallback] = await this.postgres.query<Array<{ throws: string }>>(
      `WITH roster AS (
         SELECT t.owner_steam_id AS steam_id
           FROM public.teams t
          WHERE t.id = $1::uuid
          UNION
         SELECT tr.player_steam_id
           FROM public.team_roster tr
          WHERE tr.team_id = $1::uuid
       )
       SELECT count(*)::text AS throws
         FROM public.nade_demo_throws t
         INNER JOIN roster r ON r.steam_id = t.thrower_steam_id
        WHERE ($2::text IS NULL OR t.map_name = $2::text)`,
      [teamId, mapName],
    );

    const throws = Number(fallback?.throws ?? 0);

    if (throws === 0) {
      return {
        analysed: false,
        message:
          "no demo throws have been mined for this team's roster yet, so there is nothing to report",
        entries: [],
      };
    }

    return {
      analysed: true,
      message: `${throws} mined throw(s) by this roster, none of which land in the bucket of a lineup you can see`,
      entries: [],
    };
  }

  private async assertTeam(user: User, teamId: string): Promise<void> {
    const [row] = await this.postgres.query<
      Array<{ present: boolean; member: boolean }>
    >(
      `SELECT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = $1::uuid) AS present,
              public.is_nade_team_member($1::uuid, $2::bigint) AS member`,
      [teamId, user.steam_id],
    );

    if (!row?.present) {
      throw Error("team not found");
    }

    if (!row.member && !isRoleAbove(user.role, "administrator")) {
      throw Error("you are not on that team");
    }
  }

  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private static session(user: User): string {
    return JSON.stringify({
      "x-hasura-role": user.role,
      "x-hasura-user-id": user.steam_id,
    });
  }

  private static text(value: unknown): string | null {
    const text = String(value ?? "").trim();

    return text.length > 0 ? text : null;
  }

  private static clamp(value: unknown, fallback: number, max: number): number {
    const resolved = Number(value);

    if (!Number.isFinite(resolved) || resolved <= 0) {
      return fallback;
    }

    return Math.min(Math.floor(resolved), max);
  }
}
