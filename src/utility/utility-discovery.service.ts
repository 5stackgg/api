import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { CacheService } from "../cache/cache.service";
import {
  DemoParserService,
  ParsedDiscoverCandidate,
  ParsedDiscoverTechnique,
  ParsedSmokeVolumeResponse,
} from "../demos/demo-parser.service";
import { PostgresService } from "../postgres/postgres.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { User } from "../auth/types/User";
import { isRoleAbove } from "../utilities/isRoleAbove";
import { UtilityJobs } from "./enums/UtilityJobs";
import { UtilityQueues } from "./enums/UtilityQueues";
import { UtilityPracticeService } from "./utility-practice.service";
import { UtilityLineupsService } from "./utility-lineups.service";
import { UtilityTrajectoryPoint } from "./utility-artifacts.service";
import { UtilityLoadService } from "./utility-load.service";

export type UtilityDiscoveryInput = {
  map_name: string;
  target_x: number;
  target_y: number;
  target_z: number;
  radius: number;
  area: {
    min_x: number;
    min_y: number;
    min_z: number;
    max_x: number;
    max_y: number;
    max_z: number;
    radius?: number | null;
  };
  techniques: Array<{
    direction?: string | null;
    gait?: string | null;
    jump_throw: boolean;
  }>;
  strengths?: Array<string> | null;
};

export type UtilityDiscoveryStartResult = {
  discovery_id: string | null;
  status: string;
  predicted: number;
  message: string | null;
};

// What a render server is handed to throw, and what it reports back. The
// plugin's FiveStack.Entities.Practice.DiscoveryJob / DiscoveryOutcome.
type Vec = { x: number; y: number; z: number };

export type UtilityDiscoveryJobPayload = {
  id: string;
  map: string;
  utility_type: string;
  target: Vec;
  radius: number;
  candidates: Array<{
    result_id: string;
    stand: Vec;
    direction: string;
    gait: string;
    jump_throw: boolean;
    strength: string;
    pitch: number;
    yaw: number;
  }>;
  max_grenades: number;
  max_seconds: number;
};

export type UtilityDiscoveryOutcome = {
  result_id: string;
  status: string;
  pitch: number;
  yaw: number;
  initial_position: Vec;
  initial_velocity: Vec;
  landing: Vec;
  distance: number;
  bounces: number;
  flight_time_ms: number;
  forgiveness: number;
  grenades: number;
  path?: Array<Vec>;
};

export type UtilityDiscoveryHead = {
  id: string;
  map_name: string;
  status: string;
  requested_by_steam_id: string;
  utility_practice_session_id: string | null;
  created_at: Date;
  started_at: Date | null;
};

export const UTILITY_DISCOVERY_ACTIVE = ["Predicting", "Queued", "Verifying"];

const DIRECTIONS = ["", "forward", "back", "left", "right"];
const GAITS = ["walk", "run"];
const STRENGTHS = ["Full", "Half", "Drop"];

@Injectable()
export class UtilityDiscoveryService {
  public static readonly PER_HOUR = 6;
  public static readonly MAX_QUEUED = 8;
  public static readonly MAX_TECHNIQUES = 16;
  public static readonly PREVIEWS_PER_MINUTE = 40;
  public static readonly ALREADY_RUNNING =
    "you already have a discovery running, wait for it to finish";
  // How many proposals one discovery throws, at most. Each is a handful of
  // grenades on a server somebody else may be queued behind.
  public static readonly MAX_PROPOSALS = 40;
  public static readonly MAX_GRENADES = 400;
  public static readonly MAX_SECONDS = 240;
  // A throw-from area wider than this is not one spot to stand, and the
  // search would only thin it out.
  public static readonly MAX_AREA_SIDE = 2048;
  public static readonly MIN_RADIUS = 16;
  public static readonly MAX_RADIUS = 256;
  public static readonly PREDICT_BUDGET_MS = 8000;
  public static readonly MAX_PATH_POINTS = 256;
  public static readonly PATH_EVERY_TICKS = 4;
  public static readonly SMOKE_REST_LIFT = 4;
  public static readonly WORKER_JOB_ID = "utility-discovery-queue";

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
    private readonly demoParser: DemoParserService,
    private readonly practice: UtilityPracticeService,
    private readonly lineups: UtilityLineupsService,
    private readonly load: UtilityLoadService,
    @InjectQueue(UtilityQueues.UtilityDiscovery)
    private readonly queue: Queue,
  ) {}

  public async start(
    user: User,
    input: UtilityDiscoveryInput,
  ): Promise<UtilityDiscoveryStartResult> {
    const request = UtilityDiscoveryService.normalize(input);

    if (
      !(await this.lineups.isLibraryEnabled()) ||
      !(await this.practice.isEnabled())
    ) {
      throw Error(
        "lineup discovery needs the utility library and practice servers",
      );
    }

    await this.practice.assertRole(user);

    if (!(await this.practice.canPracticeOn(request.map))) {
      throw Error("that map is not available for practice");
    }

    await this.assertBudget(user.steam_id);

    const [row] = await this.insertDiscovery(user.steam_id, request);

    const predicted = await this.demoParser.discover({
      ...request,
      limit: UtilityDiscoveryService.MAX_PROPOSALS,
      budget_ms: UtilityDiscoveryService.PREDICT_BUDGET_MS,
      snap: true,
    });

    if (!predicted.data) {
      const message =
        predicted.status === 404
          ? "there is no map geometry to search on that map yet"
          : (predicted.error ?? "the search failed");
      await this.finish(row.id, "Failed", message);
      return { discovery_id: row.id, status: "Failed", predicted: 0, message };
    }

    // The spot was picked off a radar with a guessed height; the server
    // measures its throws against the floor the search snapped it to.
    await this.postgres.query(
      `UPDATE public.utility_discoveries
          SET target_z = $2, mesh_revision = $3
        WHERE id = $1::uuid`,
      [
        row.id,
        predicted.data.target?.z ?? request.target.z,
        predicted.data.revision || null,
      ],
    );

    const candidates = predicted.data.candidates.slice(
      0,
      UtilityDiscoveryService.MAX_PROPOSALS,
    );
    await this.keepProposals(row.id, request.map, candidates);

    if (candidates.length === 0) {
      const message = "no throw from that area lands there";
      await this.finish(row.id, "Done", null);
      return { discovery_id: row.id, status: "Done", predicted: 0, message };
    }

    await this.postgres.query(
      `UPDATE public.utility_discoveries
          SET status = 'Queued', predicted = $2
        WHERE id = $1::uuid AND status = 'Predicting'`,
      [row.id, candidates.length],
    );
    await this.dispatch();

    this.logger.log(
      `[utility-discovery ${row.id}] ${request.map}: ${candidates.length} proposals from ${predicted.data.stands} spots`,
    );

    return {
      discovery_id: row.id,
      status: "Queued",
      predicted: candidates.length,
      message: null,
    };
  }

  public static normalize(input: UtilityDiscoveryInput) {
    const numbers = [
      input.target_x,
      input.target_y,
      input.target_z,
      input.radius,
      input.area?.min_x,
      input.area?.min_y,
      input.area?.min_z,
      input.area?.max_x,
      input.area?.max_y,
      input.area?.max_z,
    ];
    if (numbers.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      throw Error("the spot and the area have to be points on the map");
    }

    const map = String(input.map_name ?? "").trim();
    if (!/^[A-Za-z0-9_./-]{1,128}$/.test(map)) {
      throw Error("that is not a map");
    }

    const radius = Math.min(
      UtilityDiscoveryService.MAX_RADIUS,
      Math.max(UtilityDiscoveryService.MIN_RADIUS, input.radius),
    );

    const a = input.area;
    const min = {
      x: Math.min(a.min_x, a.max_x),
      y: Math.min(a.min_y, a.max_y),
      z: Math.min(a.min_z, a.max_z),
    };
    const max = {
      x: Math.max(a.min_x, a.max_x),
      y: Math.max(a.min_y, a.max_y),
      z: Math.max(a.min_z, a.max_z),
    };
    if (
      max.x - min.x > UtilityDiscoveryService.MAX_AREA_SIDE ||
      max.y - min.y > UtilityDiscoveryService.MAX_AREA_SIDE
    ) {
      throw Error(
        `the area to throw from can be at most ${UtilityDiscoveryService.MAX_AREA_SIDE} units across`,
      );
    }
    const circle =
      typeof a.radius === "number" && Number.isFinite(a.radius) && a.radius > 0
        ? Math.min(a.radius, UtilityDiscoveryService.MAX_AREA_SIDE)
        : undefined;

    const techniques: Array<ParsedDiscoverTechnique> = [];
    for (const t of input.techniques ?? []) {
      const direction = String(t?.direction ?? "");
      const gait = direction === "" ? "" : String(t?.gait ?? "");
      if (!DIRECTIONS.includes(direction)) {
        throw Error(`${direction} is not a direction to move in`);
      }
      if (direction !== "" && !GAITS.includes(gait)) {
        throw Error("a moving throw is a walk or a run");
      }
      const technique = {
        direction,
        gait,
        jump_throw: t?.jump_throw === true,
      } as ParsedDiscoverTechnique;
      if (
        !techniques.some(
          (kept) =>
            kept.direction === technique.direction &&
            kept.gait === technique.gait &&
            kept.jump_throw === technique.jump_throw,
        )
      ) {
        techniques.push(technique);
      }
    }
    if (techniques.length === 0) {
      throw Error("pick at least one way to throw");
    }
    if (techniques.length > UtilityDiscoveryService.MAX_TECHNIQUES) {
      throw Error(
        `pick at most ${UtilityDiscoveryService.MAX_TECHNIQUES} ways to throw`,
      );
    }

    const strengths = [...new Set(input.strengths ?? ["Full"])].filter((s) =>
      STRENGTHS.includes(s),
    ) as Array<"Full" | "Half" | "Drop">;
    if (strengths.length === 0) {
      strengths.push("Full");
    }

    return {
      map,
      target: { x: input.target_x, y: input.target_y, z: input.target_z },
      radius,
      area: { min, max, ...(circle ? { radius: circle } : {}) },
      techniques,
      strengths,
    };
  }

  private async setting(name: string): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      "SELECT value FROM public.settings WHERE name = $1 LIMIT 1",
      [name],
    );
    return row?.value ?? null;
  }

  private async assertBudget(steamId: string): Promise<void> {
    const [counts] = await this.postgres.query<
      Array<{ active: number; hour: number; queued: number }>
    >(
      `SELECT count(*) FILTER (WHERE requested_by_steam_id = $1::bigint
                                 AND status = ANY($2::text[]))::int AS active,
              count(*) FILTER (WHERE requested_by_steam_id = $1::bigint
                                 AND created_at > now() - interval '1 hour')::int AS hour,
              count(*) FILTER (WHERE status IN ('Queued', 'Verifying'))::int AS queued
         FROM public.utility_discoveries
        WHERE requested_by_steam_id = $1::bigint
           OR status IN ('Queued', 'Verifying')`,
      [steamId, UTILITY_DISCOVERY_ACTIVE],
    );
    if ((counts?.active ?? 0) > 0) {
      throw Error(UtilityDiscoveryService.ALREADY_RUNNING);
    }

    const perHour = Number(
      await this.setting(SystemSettingName.UtilityDiscoveriesPerHour),
    );
    const cap =
      Number.isFinite(perHour) && perHour > 0
        ? perHour
        : UtilityDiscoveryService.PER_HOUR;
    if ((counts?.hour ?? 0) >= cap) {
      throw Error(
        `you have used all ${cap} discoveries for this hour, try again later`,
      );
    }

    // One server throws them in turn, a few minutes each.
    if ((counts?.queued ?? 0) >= UtilityDiscoveryService.MAX_QUEUED) {
      throw Error("the discovery server is busy, try again in a few minutes");
    }
  }

  private async insertDiscovery(
    steamId: string,
    request: ReturnType<typeof UtilityDiscoveryService.normalize>,
  ): Promise<Array<{ id: string }>> {
    try {
      return await this.postgres.query<Array<{ id: string }>>(
        `INSERT INTO public.utility_discoveries
           (requested_by_steam_id, map_name, target_x, target_y, target_z,
            radius, area, techniques, strengths)
         VALUES ($1::bigint, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::text[])
         RETURNING id::text AS id`,
        [
          steamId,
          request.map,
          request.target.x,
          request.target.y,
          request.target.z,
          request.radius,
          JSON.stringify(request.area),
          JSON.stringify(request.techniques),
          request.strengths,
        ],
      );
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") {
        throw Error(UtilityDiscoveryService.ALREADY_RUNNING);
      }
      throw error;
    }
  }

  private async keepProposals(
    discoveryId: string,
    mapName: string,
    candidates: Array<ParsedDiscoverCandidate>,
  ): Promise<void> {
    for (const [rank, c] of candidates.entries()) {
      await this.postgres.query(
        `INSERT INTO public.utility_discovery_results
           (discovery_id, rank, technique, move_direction, move_gait,
            jump_throw, measured, strength,
            stand_x, stand_y, stand_z, eye_z, pitch, yaw,
            initial_pos_x, initial_pos_y, initial_pos_z,
            initial_vel_x, initial_vel_y, initial_vel_z,
            predicted_land_x, predicted_land_y, predicted_land_z,
            predicted_distance, predicted_spread, predicted_bounces, is_new)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, $20,
                 $21, $22, $23, $24, $25, $26,
                 public.utility_discovery_is_new($27, 'Smoke', $9, $10, $21, $22))`,
        [
          discoveryId,
          rank,
          c.technique_name,
          c.technique.direction || null,
          c.technique.gait || null,
          c.technique.jump_throw,
          c.measured,
          c.strength,
          c.stand.x,
          c.stand.y,
          c.stand.z,
          c.eye.z,
          c.pitch,
          c.yaw,
          c.position.x,
          c.position.y,
          c.position.z,
          c.velocity.x,
          c.velocity.y,
          c.velocity.z,
          c.landing.x,
          c.landing.y,
          c.landing.z,
          c.distance,
          Number.isFinite(c.spread) ? c.spread : 9999,
          c.bounces,
          mapName,
        ],
      );
    }
  }

  // One job for the whole queue: a single render server throws every
  // discovery in turn, changing level between maps.
  public async dispatch(): Promise<void> {
    await this.queue.add(
      UtilityJobs.RunUtilityDiscovery,
      {},
      {
        jobId: UtilityDiscoveryService.WORKER_JOB_ID,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  // A queued discovery with nothing coming for it -- an api restart, a redis
  // flush -- would wait for ever. Safe to repeat: the job id dedupes.
  public async reconcile(): Promise<void> {
    // The api stopped between asking for predictions and keeping them. Left
    // alone it would count as the player's one running discovery for ever.
    await this.postgres.query(
      `UPDATE public.utility_discoveries
          SET status = 'Failed', error = 'the search was interrupted, try again',
              finished_at = now()
        WHERE status = 'Predicting'
          AND created_at < now() - interval '5 minutes'`,
    );

    const [row] = await this.postgres.query<Array<{ waiting: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM public.utility_discoveries
          WHERE status IN ('Queued', 'Verifying')
       ) AS waiting`,
    );
    if (row?.waiting) {
      await this.dispatch();
    }
  }

  public async next(): Promise<UtilityDiscoveryHead | null> {
    const [row] = await this.postgres.query<Array<UtilityDiscoveryHead>>(
      `SELECT id::text AS id, map_name, status,
              requested_by_steam_id::text AS requested_by_steam_id,
              utility_practice_session_id::text AS utility_practice_session_id,
              created_at, started_at
         FROM public.utility_discoveries
        WHERE status IN ('Queued', 'Verifying')
        ORDER BY (status = 'Verifying') DESC, created_at ASC
        LIMIT 1`,
    );
    return row ?? null;
  }

  public async markVerifying(id: string, sessionId: string): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_discoveries
          SET status = 'Verifying', started_at = now(),
              utility_practice_session_id = $2::uuid
        WHERE id = $1::uuid AND status = 'Queued'`,
      [id, sessionId],
    );
  }

  // A run the server did not take goes back to waiting, so the next pass
  // sends it again instead of reading it as one being thrown.
  public async requeue(id: string): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_discoveries
          SET status = 'Queued', started_at = NULL,
              utility_practice_session_id = NULL
        WHERE id = $1::uuid AND status = 'Verifying'`,
      [id],
    );
  }

  public async recordBootFailure(id: string): Promise<number> {
    const [row] = await this.postgres.query<Array<{ boot_failures: number }>>(
      `UPDATE public.utility_discoveries
          SET boot_failures = boot_failures + 1
        WHERE id = $1::uuid AND status = 'Queued'
    RETURNING boot_failures`,
      [id],
    );
    return row?.boot_failures ?? 0;
  }

  public async finish(
    id: string,
    status: "Done" | "Failed" | "Cancelled",
    error: string | null,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_discoveries
          SET status = $2, error = $3, finished_at = now()
        WHERE id = $1::uuid
          AND status = ANY($4::text[])`,
      [
        id,
        status,
        error ? error.slice(0, 500) : null,
        UTILITY_DISCOVERY_ACTIVE,
      ],
    );
  }

  public async cancel(user: User, id: string): Promise<boolean> {
    const [row] = await this.postgres.query<
      Array<{
        requested_by_steam_id: string;
        status: string;
        session: string | null;
      }>
    >(
      `SELECT requested_by_steam_id::text AS requested_by_steam_id, status,
              utility_practice_session_id::text AS session
         FROM public.utility_discoveries WHERE id = $1::uuid`,
      [id],
    );
    if (!row) {
      return false;
    }
    if (
      row.requested_by_steam_id !== user.steam_id &&
      !isRoleAbove(user.role, "moderator")
    ) {
      throw Error("that discovery is not yours to stop");
    }
    await this.finish(id, "Cancelled", null);

    // The server would otherwise keep throwing it, and refuse the next one.
    if (row.status === "Verifying" && row.session) {
      const serverId = await this.practice.renderServerId(row.session);
      if (serverId) {
        await this.load.discovery(serverId, "cancel", id);
      }
    }

    return UTILITY_DISCOVERY_ACTIVE.includes(row.status);
  }

  // Backstop for a discovery server whose job died holding it. The job keeps a
  // server a few minutes after its last discovery and boots one in ten, so
  // anything quiet for longer than that is held by nothing.
  public async reapSessions(): Promise<number> {
    const stale = await this.postgres.query<Array<{ id: string }>>(
      `SELECT s.id::text AS id
         FROM public.utility_practice_sessions s
        WHERE s.is_discovery = true
          AND s.status IN ('Starting', 'Ready')
          AND s.created_at < now() - interval '15 minutes'
          AND NOT EXISTS (
            SELECT 1
              FROM public.utility_discoveries d
             WHERE d.utility_practice_session_id = s.id
               AND (
                 d.status IN ('Queued', 'Verifying')
                 OR d.finished_at > now() - interval '10 minutes'
               )
          )`,
    );

    for (const { id } of stale) {
      this.logger.warn(`[utility-discovery] reaping held session ${id}`);
      await this.practice.endRenderSession(id);
    }

    return stale.length;
  }

  // Only the server the discovery was sent to, and only while it is being
  // thrown: a stale or foreign server gets nothing.
  //
  // `late` also lets in a report that crossed the server's own "done" on the
  // way here, for a few minutes: what it carries was thrown all the same.
  private async verifying(
    id: string,
    serverId: string,
    late = false,
  ): Promise<{ map_name: string; target: Vec; radius: number } | null> {
    const [row] = await this.postgres.query<Array<any>>(
      `SELECT d.map_name, d.target_x, d.target_y, d.target_z, d.radius
         FROM public.utility_discoveries d
         JOIN public.utility_practice_sessions s ON s.id = d.utility_practice_session_id
         JOIN public.matches m ON m.id = s.match_id
        WHERE d.id = $1::uuid
          AND m.server_id = $2::uuid
          AND (
            d.status = 'Verifying'
            OR ($3::boolean AND d.status IN ('Done', 'Failed')
                AND d.finished_at > now() - interval '5 minutes')
          )`,
      [id, serverId, late],
    );
    if (!row) {
      return null;
    }
    return {
      map_name: row.map_name,
      target: {
        x: Number(row.target_x),
        y: Number(row.target_y),
        z: Number(row.target_z),
      },
      radius: Number(row.radius),
    };
  }

  public async job(
    id: string,
    serverId: string,
  ): Promise<UtilityDiscoveryJobPayload | null> {
    const discovery = await this.verifying(id, serverId);
    if (!discovery) {
      return null;
    }
    const rows = await this.postgres.query<Array<any>>(
      `SELECT id::text AS id, stand_x, stand_y, stand_z, move_direction,
              move_gait, jump_throw, strength, pitch, yaw
         FROM public.utility_discovery_results
        WHERE discovery_id = $1::uuid AND status = 'predicted'
        ORDER BY rank`,
      [id],
    );
    return {
      id,
      map: discovery.map_name,
      utility_type: "Smoke",
      target: discovery.target,
      radius: discovery.radius,
      candidates: rows.map((r) => ({
        result_id: r.id,
        stand: {
          x: Number(r.stand_x),
          y: Number(r.stand_y),
          z: Number(r.stand_z),
        },
        direction: r.move_direction ?? "",
        gait: r.move_gait ?? "",
        jump_throw: r.jump_throw === true,
        strength: r.strength,
        pitch: Number(r.pitch),
        yaw: Number(r.yaw),
      })),
      max_grenades: UtilityDiscoveryService.MAX_GRENADES,
      max_seconds: UtilityDiscoveryService.MAX_SECONDS,
    };
  }

  private static finitePoint(p: unknown): Vec | null {
    const v = p as Vec;
    if (
      !v ||
      ![v.x, v.y, v.z].every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return null;
    }
    return { x: v.x, y: v.y, z: v.z };
  }

  // The server's word on each proposal. Applied only to a proposal of this
  // discovery that has not been decided yet, so a replayed report changes
  // nothing.
  public async report(
    id: string,
    serverId: string,
    outcomes: Array<UtilityDiscoveryOutcome>,
  ): Promise<number> {
    const discovery = await this.verifying(id, serverId, true);
    if (!discovery || !Array.isArray(outcomes)) {
      return 0;
    }

    let applied = 0;
    for (const o of outcomes.slice(0, UtilityDiscoveryService.MAX_PROPOSALS)) {
      const verified = o?.status === "verified";
      const landing = UtilityDiscoveryService.finitePoint(o?.landing);
      const position = UtilityDiscoveryService.finitePoint(o?.initial_position);
      const velocity = UtilityDiscoveryService.finitePoint(o?.initial_velocity);
      const numbers = [o?.pitch, o?.yaw];
      if (
        typeof o?.result_id !== "string" ||
        (verified &&
          (!landing ||
            !position ||
            !velocity ||
            !numbers.every((n) => typeof n === "number" && Number.isFinite(n))))
      ) {
        continue;
      }

      const path = (Array.isArray(o.path) ? o.path : [])
        .map((p) => UtilityDiscoveryService.finitePoint(p))
        .filter((p): p is Vec => p !== null)
        .slice(0, UtilityDiscoveryService.MAX_PATH_POINTS);

      const number = (n: unknown) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;

      const [row] = await this.postgres.query<Array<{ id: string }>>(
        verified
          ? `UPDATE public.utility_discovery_results r
                SET status = 'verified', pitch = $3, yaw = $4,
                    initial_pos_x = $5, initial_pos_y = $6, initial_pos_z = $7,
                    initial_vel_x = $8, initial_vel_y = $9, initial_vel_z = $10,
                    land_x = $11, land_y = $12, land_z = $13,
                    distance = $14, bounces = $15, flight_time_ms = $16,
                    forgiveness = $17, grenades = $18, path = $19::jsonb,
                    verified_at = now(),
                    is_new = public.utility_discovery_is_new($20, 'Smoke', r.stand_x, r.stand_y, $11, $12)
              WHERE r.id = $1::uuid AND r.discovery_id = $2::uuid AND r.status = 'predicted'
          RETURNING r.id::text AS id`
          : `UPDATE public.utility_discovery_results r
                SET status = 'missed', grenades = $3, verified_at = now()
              WHERE r.id = $1::uuid AND r.discovery_id = $2::uuid AND r.status = 'predicted'
          RETURNING r.id::text AS id`,
        verified
          ? [
              o.result_id,
              id,
              o.pitch,
              o.yaw,
              position!.x,
              position!.y,
              position!.z,
              velocity!.x,
              velocity!.y,
              velocity!.z,
              landing!.x,
              landing!.y,
              landing!.z,
              number(o.distance),
              Number.isInteger(o.bounces) ? o.bounces : null,
              Number.isInteger(o.flight_time_ms) ? o.flight_time_ms : null,
              number(o.forgiveness),
              Number.isInteger(o.grenades) ? o.grenades : null,
              JSON.stringify(path),
              discovery.map_name,
            ]
          : [o.result_id, id, Number.isInteger(o.grenades) ? o.grenades : null],
      );
      if (row) {
        applied++;
      }
    }

    await this.postgres.query(
      `UPDATE public.utility_discoveries d
          SET verified = (SELECT count(*) FROM public.utility_discovery_results WHERE discovery_id = d.id AND status = 'verified'),
              missed = (SELECT count(*) FROM public.utility_discovery_results WHERE discovery_id = d.id AND status = 'missed'),
              grenades = (SELECT coalesce(sum(grenades), 0) FROM public.utility_discovery_results WHERE discovery_id = d.id)
        WHERE d.id = $1::uuid`,
      [id],
    );

    return applied;
  }

  public async done(
    id: string,
    serverId: string,
    error: string | null,
  ): Promise<boolean> {
    if (!(await this.verifying(id, serverId))) {
      return false;
    }
    await this.finish(id, error ? "Failed" : "Done", error);
    return true;
  }

  public async save(
    user: User,
    resultId: string,
    name: string,
    side: string,
  ): Promise<string> {
    const title = String(name ?? "").trim();
    if (side !== "TERRORIST" && side !== "CT") {
      throw Error("a lineup is for the T side or the CT side");
    }

    const lockKey = `utility-discovery-save:${resultId}`;
    const lockToken = await this.cache.acquireLock(lockKey, 60);
    if (!lockToken) {
      throw Error("that throw is already being saved");
    }

    try {
      const [row] = await this.postgres.query<Array<any>>(
        `SELECT r.*, d.map_name, d.requested_by_steam_id::text AS owner
           FROM public.utility_discovery_results r
           JOIN public.utility_discoveries d ON d.id = r.discovery_id
          WHERE r.id = $1::uuid`,
        [resultId],
      );
      if (!row || row.owner !== user.steam_id) {
        throw Error("that is not one of your discoveries");
      }
      if (row.status !== "verified") {
        throw Error("only a throw the server has landed can be saved");
      }
      if (row.utility_lineup_id) {
        return row.utility_lineup_id;
      }

      const path: Array<Vec> = Array.isArray(row.path) ? row.path : [];
      const lineupId = await this.lineups.insertDiscovered({
        author: user.steam_id,
        mapName: row.map_name,
        side,
        technique: row.technique,
        throwStrength: row.strength,
        jumpThrowBind: row.jump_throw === true,
        name: title,
        description: UtilityDiscoveryService.movement(row),
        // The server threw the seed, not a person: a walk or a run whose
        // speed is still a guess is a throw nobody has shown a human can make.
        confidence: row.measured === false ? "derived" : "exact",
        origin: { x: row.stand_x, y: row.stand_y, z: row.stand_z },
        eyeZ: row.eye_z,
        yaw: row.yaw,
        pitch: row.pitch,
        land: { x: row.land_x, y: row.land_y, z: row.land_z },
        flightTimeMs: row.flight_time_ms,
        initialPosition: {
          x: row.initial_pos_x,
          y: row.initial_pos_y,
          z: row.initial_pos_z,
        },
        initialVelocity: {
          x: row.initial_vel_x,
          y: row.initial_vel_y,
          z: row.initial_vel_z,
        },
        path: UtilityDiscoveryService.ticked(path, row.flight_time_ms),
      });

      await this.postgres.query(
        `UPDATE public.utility_discovery_results
            SET utility_lineup_id = $2::uuid
          WHERE id = $1::uuid AND utility_lineup_id IS NULL`,
        [resultId, lineupId],
      );

      return lineupId;
    } finally {
      await this.cache.releaseLock(lockKey, lockToken);
    }
  }

  // A lineup has nowhere yet to say which way to move, so a moving throw says
  // it in words.
  public static movement(row: {
    move_direction: string | null;
    move_gait: string | null;
    jump_throw: boolean;
  }): string | null {
    const key = { forward: "W", back: "S", left: "A", right: "D" }[
      row.move_direction ?? ""
    ];
    if (!key) {
      return null;
    }
    const keys = row.move_gait === "walk" ? `Shift + ${key}` : key;
    return `Hold ${keys} while you throw${row.jump_throw ? ", with the jump throw bind" : ""}.`;
  }

  // The server samples every fourth tick from release and appends where the
  // grenade came to rest, whenever that was.
  public static ticked(
    path: Array<Vec>,
    flightTimeMs: number | null,
  ): Array<UtilityTrajectoryPoint> {
    const last = Math.round(((flightTimeMs ?? 0) * 64) / 1000);
    return path.map((p, index) => ({
      tick:
        index === path.length - 1
          ? Math.max(last, index * UtilityDiscoveryService.PATH_EVERY_TICKS)
          : index * UtilityDiscoveryService.PATH_EVERY_TICKS,
      x: p.x,
      y: p.y,
      z: p.z,
    }));
  }

  // A spot picked off a radar has only a guessed height, so it is put on its
  // floor first; the page then searches from that floor. Both answers are the
  // same for everybody asking about the same spot, and the flood is the
  // expensive part, so they are kept a day. Dragging the spot asks again on
  // every stop, so it is also capped per player.
  public async smoke(
    steamId: string,
    mapName: string,
    point: Vec,
  ): Promise<{ at: Vec; volume: ParsedSmokeVolumeResponse | null } | null> {
    if (
      !/^[A-Za-z0-9_./-]{1,128}$/.test(mapName) ||
      ![point.x, point.y, point.z].every(
        (n) =>
          typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 65536,
      )
    ) {
      throw Error("that is not a point on a map");
    }

    const minute = Math.floor(Date.now() / 60000);
    const limitKey = `utility-smoke-preview-count:${steamId}:${minute}`;
    const used = Number(await this.cache.get(limitKey, 0)) + 1;
    await this.cache.put(limitKey, used, 120);
    if (used > UtilityDiscoveryService.PREVIEWS_PER_MINUTE) {
      throw Error("slow down, try that spot again in a moment");
    }

    if (!(await this.practice.canPracticeOn(mapName))) {
      throw Error("that map is not available for practice");
    }

    const cell = (n: number) => Math.round(n / 8);
    const floorKey = `utility-floor:${mapName}:${cell(point.x)}:${cell(point.y)}:${cell(point.z)}`;
    let z = (await this.cache.get(floorKey)) as number | null | undefined;
    if (z === undefined) {
      const floor = await this.demoParser.floor(mapName, point);
      if (!floor.data) {
        return null;
      }
      z = floor.data.found ? floor.data.z : null;
      await this.cache.put(floorKey, z, 86400);
    }
    if (z === null) {
      return null;
    }
    const at = { x: point.x, y: point.y, z };

    const key = `utility-smoke-preview:${mapName}:${cell(at.x)}:${cell(at.y)}:${cell(at.z)}`;
    const cached = await this.cache.get(key);
    if (cached) {
      return { at, volume: cached as ParsedSmokeVolumeResponse };
    }
    // A grenade at rest sits a few units off the floor, and the flood refuses
    // a point on the surface itself as sealed.
    const volume = await this.demoParser.smokeVolume(mapName, {
      ...at,
      z: at.z + UtilityDiscoveryService.SMOKE_REST_LIFT,
    });
    if (volume) {
      await this.cache.put(key, volume as never, 86400);
    }
    return { at, volume };
  }
}
