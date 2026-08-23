import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";
import {
  DemoParserService,
  ParsedCloudSpec,
  ParsedGeometryPoint,
  ParsedSightlinePair,
  ParsedSmokeVolumeResponse,
} from "../demos/demo-parser.service";
import { User } from "../auth/types/User";
import { UtilityArtifactsService } from "./utility-artifacts.service";

export type UtilitySightlinePairInput = {
  from_x: number;
  from_y: number;
  from_z: number;
  to_x: number;
  to_y: number;
  to_z: number;
};

export type UtilitySightlineResult = {
  index: number;
  blocked: boolean;
  blocked_by: string | null;
  depth: number;
  transmittance: number;
  world_blocked: boolean;
};

export type UtilitySightlineOutput = {
  threshold: number;
  results: Array<UtilitySightlineResult>;
  degraded: boolean;
  message: string | null;
};

export type UtilityOneWayResult = {
  index: number;
  one_way: boolean;
  favors: string | null;
  cause: string | null;
  confidence: string;
  contested: boolean;
};

export type UtilityOneWayOutput = {
  results: Array<UtilityOneWayResult>;
  degraded: boolean;
  message: string | null;
};

export type UtilityPlaybookCoverageResult = {
  index: number;
  covered: boolean;
  // The step_order of the single smoke that closes the angle. Null does not
  // mean "open": the map may be what blocks it, or two thin clouds may only
  // add up together. `covered` is the verdict; this only names a culprit.
  by_step: number | null;
  depth: number;
  transmittance: number;
};

export type UtilityPlaybookCoverageOutput = {
  results: Array<UtilityPlaybookCoverageResult>;
  degraded: boolean;
  message: string | null;
};

export type UtilityBlockingResult = {
  utility_lineup_id: string;
  depth: number;
  transmittance: number;
  blocked: boolean;
};

export type UtilityBlockingOutput = {
  results: Array<UtilityBlockingResult>;
  degraded: boolean;
  message: string | null;
};

type AnalysableLineup = {
  id: string;
  map_name: string;
  utility_type: string;
  land_x: number;
  land_y: number;
  land_z: number;
  trajectory_file: string | null;
};

@Injectable()
export class UtilityAnalysisService {
  // /sightlines takes 512 pairs and the UI asks about a handful of angles at a
  // time; the low bound is here so a single action cannot make the shared
  // parser walk a mesh 512 times on somebody's behalf.
  public static readonly MAX_PAIRS = 64;

  // The parser refuses more than 16 clouds in one request (maxRequestClouds),
  // and the whole point of the batched form is that the search costs ONE call.
  // So sixteen is the cap on candidates evaluated, not a number picked here.
  public static readonly CANDIDATE_CAP = 16;

  // A CS2 smoke floods to a radius of 144 source units, so a cloud whose centre
  // is further than that from the segment cannot put density on it. The extra
  // 48 is slack for a bloom that found free space to spread along.
  public static readonly SMOKE_REACH = 192;

  public static readonly DEFAULT_BLOCKING_LIMIT = 10;
  public static readonly MAX_BLOCKING_LIMIT = 50;

  public static readonly DEFAULT_THRESHOLD = 3.0;

  // A cloud's shape is a property of the map and the point, so it only changes
  // when the map does. A week is short enough that a map patch washes it out
  // and long enough that a browsing session pays for the flood once.
  private static readonly VOLUME_TTL_SECONDS = 7 * 24 * 60 * 60;

  // The whole blocking answer, memoized on the question. Panning a crosshair
  // around a map re-asks the same segment constantly, and the answer is
  // deterministic for as long as the library does not change.
  private static readonly BLOCKING_TTL_SECONDS = 300;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly artifacts: UtilityArtifactsService,
    private readonly demoParser: DemoParserService,
  ) {}

  public async sightlines(
    user: User | null,
    input: {
      lineup_id: string;
      pairs: Array<UtilitySightlinePairInput>;
      threshold?: number | null;
    },
  ): Promise<UtilitySightlineOutput> {
    const lineup = await this.analysableLineup(user, input.lineup_id);
    const pairs = UtilityAnalysisService.pairs(input.pairs);
    const threshold = UtilityAnalysisService.threshold(input.threshold);

    const answer = await this.demoParser.sightlines({
      map: lineup.map_name,
      smokes: [await this.cloudFor(lineup)],
      pairs,
      ...(threshold ? { threshold } : {}),
    });

    if (!answer.data) {
      return {
        threshold: threshold ?? UtilityAnalysisService.DEFAULT_THRESHOLD,
        results: [],
        degraded: true,
        message: answer.error,
      };
    }

    return {
      threshold:
        answer.data.threshold ??
        threshold ??
        UtilityAnalysisService.DEFAULT_THRESHOLD,
      results: (answer.data.results ?? []).map((result, index) => ({
        index,
        blocked: result.blocked === true,
        blocked_by: result.blocked_by || null,
        depth: result.depth ?? 0,
        transmittance: result.transmittance ?? 1,
        world_blocked: result.world_blocked === true,
      })),
      degraded: false,
      message: null,
    };
  }

  public async oneWay(
    user: User | null,
    input: { lineup_id: string; pairs: Array<UtilitySightlinePairInput> },
  ): Promise<UtilityOneWayOutput> {
    const lineup = await this.analysableLineup(user, input.lineup_id);
    const pairs = UtilityAnalysisService.pairs(input.pairs);

    // The pairs are where two players stand, not where they look from. Saying
    // so is not optional: guessing wrong moves every eye by 64 units, and an
    // eye-to-eye pair can never be one-way in the first place.
    const answer = await this.demoParser.oneWay({
      map: lineup.map_name,
      smokes: [await this.cloudFor(lineup)],
      pairs,
      positions: "feet",
    });

    if (!answer.data) {
      return { results: [], degraded: true, message: answer.error };
    }

    return {
      results: (answer.data.results ?? []).map((result, index) => ({
        index,
        one_way: result.one_way === true,
        favors: result.favors || null,
        cause: result.cause || null,
        confidence: result.confidence || "none",
        contested: result.contested === true,
      })),
      degraded: false,
      message: null,
    };
  }

  // "Your A execute leaves CT-cross open."
  //
  // Every smoke in the book is evaluated against every angle in ONE /sightlines
  // call, because an execute is the smokes together -- asking per step would
  // answer a question nobody has and cost one parser round trip per step.
  //
  // Nothing here may report an angle as open unless it really was evaluated
  // against the whole book. A parser that cannot be reached, or a book with
  // more smokes than the parser will take in one request, both come back
  // degraded: an "open" verdict from a partial evaluation is the exact false
  // claim this exists to prevent.
  public async playbookCoverage(
    user: User | null,
    input: {
      playbook_id: string;
      pairs: Array<UtilitySightlinePairInput>;
    },
  ): Promise<UtilityPlaybookCoverageOutput> {
    const pairs = UtilityAnalysisService.pairs(input.pairs);
    const playbook = await this.viewablePlaybook(user, input.playbook_id);
    const steps = await this.playbookSmokeSteps(playbook.id);

    if (steps.length === 0) {
      // Honestly open: an execute with no smokes in it closes nothing. The
      // parser is not asked, because a request with an empty cloud list would
      // only be answering what the map does.
      const uncovered = pairs.map(
        (_pair, index): UtilityPlaybookCoverageResult => ({
          index,
          covered: false,
          by_step: null,
          depth: 0,
          transmittance: 1,
        }),
      );

      return {
        results: uncovered,
        degraded: false,
        message: "this playbook has no smoke steps",
      };
    }

    const evaluated = steps.slice(0, UtilityAnalysisService.CANDIDATE_CAP);
    const truncated = steps.length > evaluated.length;
    const clouds: Array<ParsedCloudSpec> = [];

    for (const step of evaluated) {
      clouds.push(await this.cloudFor(step.lineup));
    }

    const answer = await this.demoParser.sightlines({
      map: playbook.map_name,
      smokes: clouds,
      pairs,
    });

    if (!answer.data) {
      return { results: [], degraded: true, message: answer.error };
    }

    const threshold =
      answer.data.threshold ?? UtilityAnalysisService.DEFAULT_THRESHOLD;

    const results = (answer.data.results ?? []).map((result, index) => {
      const perSmoke = result.per_smoke ?? [];
      let byStep: number | null = null;
      let best = threshold;

      for (const [candidate, step] of evaluated.entries()) {
        const depth = perSmoke[candidate] ?? 0;

        if (depth >= best) {
          best = depth;
          byStep = step.step_order;
        }
      }

      return {
        index,
        covered: result.blocked === true,
        by_step: byStep,
        depth: result.depth ?? 0,
        transmittance: result.transmittance ?? 1,
      };
    });

    return {
      results,
      degraded: truncated,
      message: truncated
        ? `only the first ${UtilityAnalysisService.CANDIDATE_CAP} smokes in this playbook were evaluated`
        : null,
    };
  }

  // The inverted search: not "what lineups exist here" but "what closes this
  // angle". Only a smoke can, and only one already near the line, so the
  // candidate set is cut geometrically before a single volume is resolved.
  public async findBlocking(
    user: User | null,
    input: {
      map_name: string;
      from_x: number;
      from_y: number;
      from_z: number;
      to_x: number;
      to_y: number;
      to_z: number;
      side?: string | null;
      limit?: number | null;
    },
  ): Promise<UtilityBlockingOutput> {
    const from = UtilityAnalysisService.point(
      input.from_x,
      input.from_y,
      input.from_z,
    );
    const to = UtilityAnalysisService.point(input.to_x, input.to_y, input.to_z);
    const requested = Math.trunc(Number(input.limit ?? 0));
    const limit = Math.min(
      requested > 0 ? requested : UtilityAnalysisService.DEFAULT_BLOCKING_LIMIT,
      UtilityAnalysisService.MAX_BLOCKING_LIMIT,
    );
    const mapName = String(input.map_name ?? "").trim();

    if (!mapName) {
      throw Error("map_name is required");
    }

    const cacheKey = this.blockingCacheKey(user, mapName, from, to, input.side);
    const cached = (await this.cache.get(cacheKey)) as
      | UtilityBlockingOutput
      | undefined;

    if (cached) {
      return { ...cached, results: cached.results.slice(0, limit) };
    }

    const candidates = await this.blockingCandidates(
      user,
      mapName,
      from,
      to,
      input.side ?? null,
    );

    if (candidates.length === 0) {
      return { results: [], degraded: false, message: null };
    }

    if (candidates.length === UtilityAnalysisService.CANDIDATE_CAP) {
      this.logger.log(
        `[utility-blocking] ${mapName}: evaluating the ${UtilityAnalysisService.CANDIDATE_CAP} smokes nearest the line; more were in reach`,
      );
    }

    const clouds: Array<ParsedCloudSpec> = [];

    for (const candidate of candidates) {
      clouds.push(await this.cloudFor(candidate));
    }

    const answer = await this.demoParser.sightlines({
      map: mapName,
      smokes: clouds,
      pairs: [{ from, to }],
    });

    if (!answer.data) {
      return { results: [], degraded: true, message: answer.error };
    }

    const pair = answer.data.results?.at(0);

    if (!pair) {
      return {
        results: [],
        degraded: true,
        message: "the parser answered no results for this line",
      };
    }

    if (pair.world_blocked) {
      const output: UtilityBlockingOutput = {
        results: [],
        degraded: false,
        message: "the map already blocks this line; no smoke is needed",
      };
      await this.cache.put(
        cacheKey,
        output,
        UtilityAnalysisService.BLOCKING_TTL_SECONDS,
      );
      return output;
    }

    const threshold =
      answer.data.threshold ?? UtilityAnalysisService.DEFAULT_THRESHOLD;
    const perSmoke = pair.per_smoke ?? [];

    const results = candidates
      .map((candidate, index) => {
        const depth = perSmoke[index] ?? 0;
        return {
          utility_lineup_id: candidate.id,
          depth,
          transmittance: Math.exp(-depth),
          blocked: depth >= threshold,
        };
      })
      .sort((a, b) => b.depth - a.depth);

    const output: UtilityBlockingOutput = {
      results,
      degraded: false,
      message: null,
    };

    await this.cache.put(
      cacheKey,
      output,
      UtilityAnalysisService.BLOCKING_TTL_SECONDS,
    );

    return { ...output, results: results.slice(0, limit) };
  }

  // Both a permission check and the row loader. A lineup the caller cannot see
  // must not be analysable either -- the geometry of a private lineup is the
  // private part.
  private async analysableLineup(
    user: User | null,
    lineupId: string,
  ): Promise<AnalysableLineup> {
    if (!UtilityAnalysisService.isUuid(lineupId)) {
      throw Error("lineup not found");
    }

    const [row] = await this.postgres.query<
      Array<AnalysableLineup & { visible: boolean }>
    >(
      `SELECT public.can_view_utility_lineup(l, $2::json) AS visible,
              l.id::text AS id, l.map_name, l.utility_type,
              l.land_x, l.land_y, l.land_z, l.trajectory_file
         FROM public.utility_lineups l
        WHERE l.id = $1::uuid`,
      [lineupId, UtilityAnalysisService.session(user)],
    );

    if (!row || !row.visible) {
      throw Error("lineup not found");
    }

    return row;
  }

  // A book the caller cannot open must not be analysable either: its steps are
  // other people's lineups, and the shape of an execute is the private part.
  private async viewablePlaybook(
    user: User | null,
    playbookId: string,
  ): Promise<{ id: string; map_name: string }> {
    if (!UtilityAnalysisService.isUuid(playbookId)) {
      throw Error("playbook not found");
    }

    const [row] = await this.postgres.query<
      Array<{ id: string; map_name: string; visible: boolean }>
    >(
      `SELECT p.id::text AS id, p.map_name,
              public.can_view_utility_playbook(p, $2::json) AS visible
         FROM public.utility_playbooks p
        WHERE p.id = $1::uuid`,
      [playbookId, UtilityAnalysisService.session(user)],
    );

    if (!row || !row.visible) {
      throw Error("playbook not found");
    }

    return { id: row.id, map_name: row.map_name };
  }

  // Only smokes: a flash or a molly puts no density on a sightline, so sending
  // one as a cloud would ask the parser to bloom something that cannot block.
  private async playbookSmokeSteps(
    playbookId: string,
  ): Promise<Array<{ step_order: number; lineup: AnalysableLineup }>> {
    const rows = await this.postgres.query<
      Array<AnalysableLineup & { step_order: number }>
    >(
      `SELECT st.step_order,
              l.id::text AS id, l.map_name, l.utility_type,
              l.land_x, l.land_y, l.land_z, l.trajectory_file
         FROM public.utility_playbook_steps st
         INNER JOIN public.utility_lineups l ON l.id = st.utility_lineup_id
        WHERE st.playbook_id = $1::uuid
          AND l.utility_type = 'Smoke'
        ORDER BY st.step_order ASC`,
      [playbookId],
    );

    return rows.map(({ step_order, ...lineup }) => ({
      step_order: Number(step_order),
      lineup,
    }));
  }

  private async blockingCandidates(
    user: User | null,
    mapName: string,
    from: ParsedGeometryPoint,
    to: ParsedGeometryPoint,
    side: string | null,
  ): Promise<Array<AnalysableLineup>> {
    // The pre-filter is the whole cost control: distance from the landing point
    // to the SEGMENT (not to either end), so a cloud beside the middle of a long
    // sightline survives and one behind the shooter does not.
    return await this.postgres.query<Array<AnalysableLineup>>(
      `WITH seg AS (
         SELECT $2::float8 AS ax, $3::float8 AS ay, $4::float8 AS az,
                $5::float8 AS bx, $6::float8 AS by, $7::float8 AS bz
       )
       SELECT l.id::text AS id, l.map_name, l.utility_type,
              l.land_x, l.land_y, l.land_z, l.trajectory_file
         FROM public.utility_lineups l
        CROSS JOIN seg
        CROSS JOIN LATERAL (
          SELECT greatest(
                   0::float8,
                   least(
                     1::float8,
                     CASE
                       WHEN (seg.bx - seg.ax) ^ 2 + (seg.by - seg.ay) ^ 2 + (seg.bz - seg.az) ^ 2 = 0
                         THEN 0::float8
                       ELSE (
                              (l.land_x - seg.ax) * (seg.bx - seg.ax) +
                              (l.land_y - seg.ay) * (seg.by - seg.ay) +
                              (l.land_z - seg.az) * (seg.bz - seg.az)
                            ) / (
                              (seg.bx - seg.ax) ^ 2 + (seg.by - seg.ay) ^ 2 + (seg.bz - seg.az) ^ 2
                            )
                     END
                   )
                 ) AS t
        ) AS projection
        CROSS JOIN LATERAL (
          SELECT sqrt(
                   (l.land_x - (seg.ax + projection.t * (seg.bx - seg.ax))) ^ 2 +
                   (l.land_y - (seg.ay + projection.t * (seg.by - seg.ay))) ^ 2 +
                   (l.land_z - (seg.az + projection.t * (seg.bz - seg.az))) ^ 2
                 ) AS reach
        ) AS gap
        WHERE l.map_name = $1
          AND l.utility_type = 'Smoke'
          AND l.archived_at IS NULL
          AND ($9::text IS NULL OR l.side = $9::text)
          AND gap.reach <= $10::float8
          AND public.can_view_utility_lineup(l, $8::json)
        ORDER BY gap.reach ASC, l.upvotes DESC, l.id ASC
        LIMIT ${UtilityAnalysisService.CANDIDATE_CAP}`,
      [
        mapName,
        from.x,
        from.y,
        from.z,
        to.x,
        to.y,
        to.z,
        UtilityAnalysisService.session(user),
        side ?? null,
        UtilityAnalysisService.SMOKE_REACH,
      ],
    );
  }

  // Cheapest source first: the memo, then the bloom the artifact already
  // carries, then a flood from the parser. Falling through to `at` is not a
  // failure -- it asks the parser to bloom the point inside the same request,
  // which is what happens anyway when nothing measured it yet.
  private async cloudFor(lineup: AnalysableLineup): Promise<ParsedCloudSpec> {
    const land = UtilityAnalysisService.point(
      lineup.land_x,
      lineup.land_y,
      lineup.land_z,
    );
    const key = UtilityAnalysisService.volumeCacheKey(lineup.map_name, land);

    const cached = (await this.cache.get(key)) as
      | ParsedSmokeVolumeResponse
      | undefined;

    if (cached) {
      return { volume: cached };
    }

    const volume =
      (lineup.trajectory_file
        ? await this.artifacts.readSmokeVolume(lineup.trajectory_file)
        : null) ?? (await this.demoParser.smokeVolume(lineup.map_name, land));

    if (!volume) {
      return { at: land };
    }

    await this.cache.put(key, volume, UtilityAnalysisService.VOLUME_TTL_SECONDS);

    return { volume };
  }

  private blockingCacheKey(
    user: User | null,
    mapName: string,
    from: ParsedGeometryPoint,
    to: ParsedGeometryPoint,
    side?: string | null,
  ): string {
    // Keyed on the caller as well as the question: the candidate set is cut by
    // can_view_utility_lineup, so two players asking the same question are not
    // asking the same question.
    const at = (point: ParsedGeometryPoint) =>
      `${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}`;

    return `utility:blocking:${user?.steam_id ?? "guest"}:${user?.role ?? "guest"}:${mapName}:${at(from)}:${at(to)}:${side ?? "any"}`;
  }

  private static volumeCacheKey(
    mapName: string,
    point: ParsedGeometryPoint,
  ): string {
    return `utility:volume:${mapName}:${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}`;
  }

  private static session(user: User | null): string {
    return JSON.stringify({
      "x-hasura-role": user?.role ?? "guest",
      ...(user?.steam_id ? { "x-hasura-user-id": user.steam_id } : {}),
    });
  }

  private static pairs(
    input: Array<UtilitySightlinePairInput>,
  ): Array<ParsedSightlinePair> {
    if (!Array.isArray(input) || input.length === 0) {
      throw Error("at least one pair is required");
    }

    if (input.length > UtilityAnalysisService.MAX_PAIRS) {
      throw Error(`at most ${UtilityAnalysisService.MAX_PAIRS} pairs at a time`);
    }

    return input.map((pair) => ({
      from: UtilityAnalysisService.point(pair.from_x, pair.from_y, pair.from_z),
      to: UtilityAnalysisService.point(pair.to_x, pair.to_y, pair.to_z),
    }));
  }

  private static point(x: number, y: number, z: number): ParsedGeometryPoint {
    for (const value of [x, y, z]) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw Error("coordinates must be finite numbers");
      }
    }

    return { x, y, z };
  }

  private static threshold(value?: number | null): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (!Number.isFinite(value) || value <= 0) {
      throw Error("threshold must be a positive number");
    }

    return value;
  }

  private static isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(value ?? ""),
    );
  }
}
