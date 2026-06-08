import { Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { e_player_roles_enum } from "generated/schema";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";
import { S3Service } from "../../s3/s3.service";
import { GameStreamerService } from "../game-streamer/game-streamer.service";
import { SteamAccountService } from "../game-streamer/steam-account.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { ClipSpec } from "./types/ClipSpec";
import { ClipRenderStatusDto } from "./types/ClipRenderStatusDto";
import {
  BATCH_HIGHLIGHTS_JOB_NAME,
  IN_FLIGHT_STATUSES,
  TERMINAL_STATUSES,
  resolveInClusterApiBase,
} from "./clips.constants";
const STATUS_HISTORY_CAP = 50;
const LAST_TICK_FOR_MALFORMED = Number.MAX_SAFE_INTEGER;

type ClipSegmentSpec = ClipSpec["segments"][number];

@Injectable()
export class ClipsService {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
    private readonly gameStreamer: GameStreamerService,
    private readonly steamAccounts: SteamAccountService,
    @InjectQueue(MatchQueues.Clips)
    private readonly batchQueue: Queue,
  ) {}

  public static GetClipS3Key(userSteamId: string, jobId: string) {
    return `clips/${userSteamId}/${jobId}.mp4`;
  }
  public static GetClipThumbnailS3Key(userSteamId: string, jobId: string) {
    return `clips/${userSteamId}/${jobId}.jpg`;
  }

  public static clipFirstTick(spec: unknown): number {
    let min: number | null = null;
    for (const s of ClipsService.asSegments(spec)) {
      const t = ClipsService.toFiniteNumber(s?.start_tick);
      if (t === null) continue;
      if (min === null || t < min) min = t;
    }
    return min ?? LAST_TICK_FOR_MALFORMED;
  }

  public static clipLastActionTick(spec: unknown): number {
    let max: number | null = null;
    for (const s of ClipsService.asSegments(spec)) {
      const kill = ClipsService.toFiniteNumber(s?.kill_tick);
      const end = ClipsService.toFiniteNumber(s?.end_tick);
      const tick = kill ?? end;
      if (tick === null) continue;
      if (max === null || tick > max) max = tick;
    }
    return max ?? LAST_TICK_FOR_MALFORMED;
  }

  public static compareHighlightJobs<T extends { spec: unknown }>(
    a: T,
    b: T,
  ): number {
    const byLastAction =
      ClipsService.clipLastActionTick(a.spec) -
      ClipsService.clipLastActionTick(b.spec);
    if (byLastAction !== 0) return byLastAction;
    return (
      ClipsService.clipFirstTick(a.spec) - ClipsService.clipFirstTick(b.spec)
    );
  }

  public static orderHighlightJobs<T extends { spec: unknown }>(
    rows: ReadonlyArray<T>,
  ): T[] {
    return [...rows].sort(ClipsService.compareHighlightJobs);
  }

  private static asSegments(spec: unknown): Array<{
    start_tick?: unknown;
    end_tick?: unknown;
    kill_tick?: unknown;
  }> {
    const segments = (spec as { segments?: unknown } | null | undefined)
      ?.segments;
    return Array.isArray(segments) ? segments : [];
  }

  private static toFiniteNumber(v: unknown): number | null {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private static filterValidKills<
    T extends {
      killer?: string;
      victim?: string;
      killer_team?: string;
      victim_team?: string;
    },
  >(kills: ReadonlyArray<T> | undefined | null): T[] {
    if (!kills) return [];
    return kills.filter((k) => {
      const killer = k?.killer ? String(k.killer) : "";
      if (!killer) return false;
      const victim = k?.victim ? String(k.victim) : "";
      if (victim && killer === victim) return false;
      const killerTeam = k?.killer_team ? String(k.killer_team) : "";
      const victimTeam = k?.victim_team ? String(k.victim_team) : "";
      if (killerTeam && victimTeam && killerTeam === victimTeam) return false;
      return true;
    });
  }

  public async createClipRender(
    userSteamId: string,
    spec: ClipSpec,
  ): Promise<{ jobId: string }> {
    this.validateSpec(spec);

    const session = await this.findActiveDemoSession(
      userSteamId,
      spec.match_map_id,
    );
    if (!session) {
      throw new Error(
        "open the demo (click 'Watch demo') before creating a clip — the render runs in the same pod that's playing it back",
      );
    }

    const inflight = await this.findInFlightForUser(userSteamId);
    if (inflight) {
      throw new Error(
        "you already have a clip render in progress — wait for it to finish or cancel it",
      );
    }

    const sessionToken = randomBytes(24).toString("hex");

    const { insert_clip_render_jobs_one } = await this.hasura.mutation({
      insert_clip_render_jobs_one: {
        __args: {
          object: {
            user_steam_id: userSteamId,
            match_map_id: spec.match_map_id,
            match_map_demo_id: session.match_map_demo_id,
            session_token: sessionToken,
            k8s_job_name: session.k8s_job_name,
            spec,
            status: "queued",
            status_history: [
              { status: "queued", at: new Date().toISOString() },
            ],
          },
        },
        id: true,
      },
    });
    const jobId = insert_clip_render_jobs_one?.id;
    if (!jobId) {
      throw new Error("failed to insert clip_render_jobs row");
    }

    const dims = spec.output.resolution === "720p" ? "1280x720" : "1920x1080";
    const totalTicks = spec.segments.reduce(
      (acc, s) => acc + (s.end_tick - s.start_tick),
      0,
    );

    this.logger.log(
      `[clip ${jobId}] dispatching to pod=${session.id} ` +
        `segments=${spec.segments.length} total_ticks=${totalTicks} ` +
        `output=${dims}@${spec.output.fps}fps ` +
        `dest=${spec.destination}`,
    );

    try {
      await this.gameStreamer.dispatchClipRenderToPod(session.id, {
        job_id: jobId,
        token: sessionToken,
        api_base: resolveInClusterApiBase(),
        segments: spec.segments.map((s) => ({
          start_tick: s.start_tick,
          end_tick: s.end_tick,
          kill_tick: s.kill_tick,
          pov_steam_id: s.pov_steam_id,
        })),
        output_dims: dims,
        output_fps: spec.output.fps,
      });
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] dispatch to pod failed: ${(error as Error)?.message}`,
      );
      await this.hasura.mutation({
        update_clip_render_jobs_by_pk: {
          __args: {
            pk_columns: { id: jobId },
            _set: {
              status: "error",
              error_message: `dispatch failed: ${(error as Error)?.message}`,
              last_status_at: "now()",
              game_server_node_id: null,
            },
          },
          id: true,
        },
      });
      throw error;
    }

    return { jobId };
  }

  public async cancelClipRenderBatch(matchMapId: string): Promise<number> {
    const { clip_render_jobs: inFlightRows } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
          },
          distinct_on: ["match_map_demo_id"],
        },
        match_map_demo_id: true,
      },
    });
    const demoIds = (inFlightRows ?? [])
      .map((r) => (r?.match_map_demo_id ? String(r.match_map_demo_id) : null))
      .filter((id): id is string => !!id);

    const { update_clip_render_jobs } = await this.hasura.mutation({
      update_clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
          },
          _set: {
            status: "cancelled",
            error_message: "cancelled by operator (batch)",
            last_status_at: "now()",
            game_server_node_id: null,
          },
        },
        affected_rows: true,
      },
    });
    const cancelled = (update_clip_render_jobs?.affected_rows as number) ?? 0;

    try {
      const queued = await this.batchQueue.getJobs([
        "delayed",
        "waiting",
        "active",
        "paused",
      ]);
      for (const q of queued) {
        if (q.data?.matchMapId === matchMapId) {
          await q.remove();
        }
      }
    } catch (error) {
      this.logger.warn(
        `[cancel-batch ${matchMapId}] BullMQ remove failed: ${(error as Error)?.message}`,
      );
    }

    for (const demoId of demoIds) {
      try {
        await this.gameStreamer.killBatchHighlightsPod(matchMapId, demoId);
      } catch (error) {
        this.logger.warn(
          `[cancel-batch ${matchMapId} demo ${demoId}] pod kill failed: ${(error as Error)?.message}`,
        );
      }
    }

    this.logger.log(
      `[cancel-batch ${matchMapId}] cancelled ${cancelled} row(s) across ${demoIds.length} demo(s) and torn down pods`,
    );
    return cancelled;
  }

  public async isRenderResumeLocked(): Promise<boolean> {
    const { match_streams } = await this.hasura.query({
      match_streams: {
        __args: {
          where: {
            is_game_streamer: { _eq: true },
            status: { _nin: ["errored"] },
          },
          limit: 1,
        },
        id: true,
      },
    });
    if ((match_streams ?? []).length > 0) return true;

    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: { name: "pause_renders_during_active_match" },
        value: true,
      },
    });
    if (settings_by_pk?.value !== "true") return false;

    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            status: { _eq: "Live" },
            server: {
              game_server_node: {
                gpu: { _eq: true },
              },
            },
          },
          limit: 1,
        },
        id: true,
      },
    });
    return (matches ?? []).length > 0;
  }

  public async pauseInFlightBatchesOnNode(nodeId: string): Promise<number> {
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            game_server_node_id: { _eq: nodeId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
            paused: { _eq: false },
          },
          distinct_on: ["match_map_id"],
        },
        match_map_id: true,
      },
    });
    const matchMapIds = (clip_render_jobs ?? [])
      .map((r) => (r?.match_map_id ? String(r.match_map_id) : null))
      .filter((id): id is string => !!id);
    let total = 0;
    for (const matchMapId of matchMapIds) {
      total += await this.pauseClipRenderBatch(matchMapId, nodeId);
    }
    return total;
  }

  public async pauseAllInFlightBatches(): Promise<number> {
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            status: { _in: [...IN_FLIGHT_STATUSES] },
            paused: { _eq: false },
          },
          distinct_on: ["match_map_id"],
        },
        match_map_id: true,
      },
    });
    const matchMapIds = (clip_render_jobs ?? [])
      .map((r) => (r?.match_map_id ? String(r.match_map_id) : null))
      .filter((id): id is string => !!id);
    let total = 0;
    for (const matchMapId of matchMapIds) {
      total += await this.pauseClipRenderBatch(matchMapId);
    }
    return total;
  }

  public async pauseClipRenderBatch(
    matchMapId: string,
    nodeId?: string,
  ): Promise<number> {
    const nodeFilter = nodeId ? { game_server_node_id: { _eq: nodeId } } : {};

    const { clip_render_jobs: inFlightRows } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
            ...nodeFilter,
          },
          distinct_on: ["match_map_demo_id"],
        },
        match_map_demo_id: true,
      },
    });
    const demoIds = (inFlightRows ?? [])
      .map((r) => (r?.match_map_demo_id ? String(r.match_map_demo_id) : null))
      .filter((id): id is string => !!id);

    const { update_clip_render_jobs } = await this.hasura.mutation({
      update_clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
            ...nodeFilter,
          },
          _set: {
            paused: true,
            status: "queued",
            game_server_node_id: null,
          },
        },
        affected_rows: true,
      },
    });
    const paused = (update_clip_render_jobs?.affected_rows as number) ?? 0;

    try {
      const queued = await this.batchQueue.getJobs([
        "delayed",
        "waiting",
        "active",
        "paused",
      ]);
      for (const q of queued) {
        if (q.data?.matchMapId === matchMapId) {
          await q.remove();
        }
      }
    } catch (error) {
      this.logger.warn(
        `[pause-batch ${matchMapId}] BullMQ remove failed: ${(error as Error)?.message}`,
      );
    }

    for (const demoId of demoIds) {
      try {
        await this.gameStreamer.killBatchHighlightsPod(matchMapId, demoId);
      } catch (error) {
        this.logger.warn(
          `[pause-batch ${matchMapId} demo ${demoId}] pod kill failed: ${(error as Error)?.message}`,
        );
      }
    }

    this.logger.log(
      `[pause-batch ${matchMapId}] paused ${paused} row(s) across ${demoIds.length} demo(s), pod(s) torn down`,
    );
    return paused;
  }

  public async resumeClipRenderBatch(matchMapId: string): Promise<number> {
    if (await this.isRenderResumeLocked()) {
      this.logger.log(
        `[resume-batch ${matchMapId}] skipped — render-resume locked by active match on GPU node`,
      );
      return 0;
    }
    const { update_clip_render_jobs } = await this.hasura.mutation({
      update_clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            paused: { _eq: true },
          },
          _set: {
            paused: false,
          },
        },
        affected_rows: true,
      },
    });
    const cleared = (update_clip_render_jobs?.affected_rows as number) ?? 0;
    if (cleared === 0) {
      return 0;
    }

    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _eq: "queued" },
          },
          distinct_on: ["match_map_demo_id"],
        },
        match_map_demo_id: true,
      },
    });
    const demoIds = (clip_render_jobs ?? [])
      .map((r) => (r?.match_map_demo_id ? String(r.match_map_demo_id) : null))
      .filter((id): id is string => !!id);

    for (const matchMapDemoId of demoIds) {
      try {
        const existing = await this.batchQueue.getJobs([
          "delayed",
          "waiting",
          "active",
          "paused",
        ]);
        const alreadyEnqueued = existing.some(
          (j) =>
            j.name === BATCH_HIGHLIGHTS_JOB_NAME &&
            j.data?.matchMapId === matchMapId &&
            j.data?.matchMapDemoId === matchMapDemoId,
        );
        if (!alreadyEnqueued) {
          await this.batchQueue.add(
            BATCH_HIGHLIGHTS_JOB_NAME,
            { matchMapId, matchMapDemoId },
            { jobId: `${matchMapId}-${matchMapDemoId}-${Date.now()}` },
          );
        }
      } catch (error) {
        this.logger.warn(
          `[resume-batch ${matchMapId}/${matchMapDemoId}] enqueue failed: ${(error as Error)?.message}`,
        );
      }
    }

    this.logger.log(
      `[resume-batch ${matchMapId}] cleared paused on ${cleared} row(s), re-enqueued ${demoIds.length} demo(s)`,
    );
    return cleared;
  }

  public async resumeAllPausedBatches(): Promise<number> {
    if (await this.isRenderResumeLocked()) {
      this.logger.log(
        `[resume-all] skipped — render-resume locked by active match(es) on GPU node(s)`,
      );
      return 0;
    }
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            paused: { _eq: true },
            status: { _eq: "queued" },
          },
          distinct_on: ["match_map_id"],
        },
        match_map_id: true,
      },
    });
    const matchMapIds = (clip_render_jobs ?? [])
      .map((r) => (r?.match_map_id ? String(r.match_map_id) : null))
      .filter((id): id is string => !!id);
    let total = 0;
    for (const matchMapId of matchMapIds) {
      total += await this.resumeClipRenderBatch(matchMapId);
    }
    return total;
  }

  public async clearClipRenderBatch(matchMapId: string): Promise<number> {
    const { delete_clip_render_jobs } = await this.hasura.mutation({
      delete_clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _in: [...TERMINAL_STATUSES] },
          },
        },
        affected_rows: true,
      },
    });
    const cleared =
      (delete_clip_render_jobs?.affected_rows as number | undefined) ?? 0;
    this.logger.log(
      `[clear-batch ${matchMapId}] cleared ${cleared} terminal row(s)`,
    );
    return cleared;
  }

  // Re-inserts rows via the BATCH path (status=queued + dedicated
  // BatchHighlights pod), bypassing the interactive createClipRender
  // flow which requires the user to have a live demo session open.
  private async enqueueBatchClipRenders(
    rows: Array<{
      user_steam_id: unknown;
      match_map_id: unknown;
      match_map_demo_id: unknown;
      spec: unknown;
    }>,
    label: string,
  ): Promise<number> {
    const byDemo = new Map<
      string,
      {
        matchMapId: string;
        matchMapDemoId: string;
        objects: Array<Record<string, unknown>>;
      }
    >();

    for (const r of rows) {
      const matchMapId = r.match_map_id ? String(r.match_map_id) : null;
      const matchMapDemoId = r.match_map_demo_id
        ? String(r.match_map_demo_id)
        : null;
      if (!matchMapId || !matchMapDemoId || !r.spec) {
        this.logger.warn(
          `[${label}] skip row: missing match_map_id / match_map_demo_id / spec`,
        );
        continue;
      }
      const key = `${matchMapId}:${matchMapDemoId}`;
      const bucket = byDemo.get(key) ?? {
        matchMapId,
        matchMapDemoId,
        objects: [],
      };
      bucket.objects.push({
        user_steam_id: r.user_steam_id ? String(r.user_steam_id) : null,
        match_map_id: matchMapId,
        match_map_demo_id: matchMapDemoId,
        session_token: randomBytes(24).toString("hex"),
        k8s_job_name: GameStreamerService.GetBatchHighlightsJobName(
          matchMapId,
          matchMapDemoId,
        ),
        spec: r.spec,
        status: "queued",
        sort_index: bucket.objects.length,
        status_history: [
          { status: "queued", at: new Date().toISOString(), source: label },
        ],
      });
      byDemo.set(key, bucket);
    }

    let inserted = 0;
    for (const { matchMapId, matchMapDemoId, objects } of byDemo.values()) {
      if (objects.length === 0) continue;
      try {
        const { insert_clip_render_jobs } = await this.hasura.mutation({
          insert_clip_render_jobs: {
            __args: { objects: objects as any },
            returning: { id: true },
          },
        });
        const n = (
          (insert_clip_render_jobs?.returning as Array<{ id: string }>) ?? []
        ).length;
        inserted += n;
      } catch (error) {
        this.logger.warn(
          `[${label} ${matchMapId}/${matchMapDemoId}] insert failed: ${(error as Error)?.message}`,
        );
        continue;
      }

      try {
        const existing = await this.batchQueue.getJobs([
          "delayed",
          "waiting",
          "active",
          "paused",
        ]);
        const alreadyEnqueued = existing.some(
          (j) =>
            j.name === BATCH_HIGHLIGHTS_JOB_NAME &&
            j.data?.matchMapId === matchMapId &&
            j.data?.matchMapDemoId === matchMapDemoId,
        );
        if (!alreadyEnqueued) {
          await this.batchQueue.add(
            BATCH_HIGHLIGHTS_JOB_NAME,
            { matchMapId, matchMapDemoId },
            { jobId: `${matchMapId}-${matchMapDemoId}-${Date.now()}` },
          );
        }
      } catch (error) {
        this.logger.warn(
          `[${label} ${matchMapId}/${matchMapDemoId}] enqueue failed: ${(error as Error)?.message}`,
        );
      }
    }

    return inserted;
  }

  public async retryClipRenderBatch(
    matchMapId: string,
    onlyFailed: boolean,
  ): Promise<number> {
    const statuses = onlyFailed
      ? (["error", "cancelled"] as const)
      : TERMINAL_STATUSES;

    const { clip_render_jobs: rows } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            status: { _in: [...statuses] },
          },
        },
        id: true,
        user_steam_id: true,
        match_map_id: true,
        match_map_demo_id: true,
        spec: true,
      },
    });
    if (!rows?.length) return 0;

    const ids = rows.map((r) => String(r.id));
    await this.hasura.mutation({
      delete_clip_render_jobs: {
        __args: { where: { id: { _in: ids } } },
        affected_rows: true,
      },
    });

    const retried = await this.enqueueBatchClipRenders(
      rows as any,
      `retry-batch ${matchMapId}`,
    );

    this.logger.log(
      `[retry-batch ${matchMapId}] deleted ${ids.length} terminal row(s), re-queued ${retried} (onlyFailed=${onlyFailed})`,
    );
    return retried;
  }

  public async requeueClipRender(jobId: string): Promise<void> {
    // Delete-then-recreate via the BATCH path so it doesn't require
    // the user to have an active demo session (createClipRender does).
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
        user_steam_id: true,
        match_map_id: true,
        match_map_demo_id: true,
        status: true,
        spec: true,
      },
    });
    if (!row) {
      throw new Error(`clip render ${jobId} not found`);
    }
    const status = String(row.status);
    if (status !== "error" && status !== "cancelled" && status !== "done") {
      throw new Error(
        `clip render ${jobId} is not in a terminal state (status=${status})`,
      );
    }
    if (!row.spec) {
      throw new Error(`clip render ${jobId} has no spec to re-create from`);
    }
    if (!row.match_map_demo_id) {
      throw new Error(
        `clip render ${jobId} has no match_map_demo_id — cannot dispatch via batch worker`,
      );
    }

    await this.hasura.mutation({
      delete_clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
      },
    });

    const inserted = await this.enqueueBatchClipRenders(
      [row as any],
      `requeue ${jobId}`,
    );
    if (inserted === 0) {
      throw new Error(`failed to re-queue clip render ${jobId}`);
    }
  }

  public async clearFinishedClipRenders(): Promise<number> {
    const { delete_clip_render_jobs } = await this.hasura.mutation({
      delete_clip_render_jobs: {
        __args: {
          where: {
            status: { _in: [...TERMINAL_STATUSES] },
          },
        },
        affected_rows: true,
      },
    });
    const cleared =
      (delete_clip_render_jobs?.affected_rows as number | undefined) ?? 0;
    this.logger.log(`[clear-finished] cleared ${cleared} terminal row(s)`);
    return cleared;
  }

  public async cancelClipRender(userSteamId: string, jobId: string) {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
        user_steam_id: true,
        match_map_id: true,
        match_map_demo_id: true,
        k8s_job_name: true,
        status: true,
      },
    });
    if (!row) {
      throw new Error(`clip render ${jobId} not found`);
    }
    if (String(row.user_steam_id) !== String(userSteamId)) {
      throw new Error("you can only cancel your own clip renders");
    }
    if (
      row.status === "done" ||
      row.status === "error" ||
      row.status === "cancelled"
    ) {
      return;
    }

    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: {
          pk_columns: { id: jobId },
          _set: {
            status: "cancelled",
            error_message: "cancelled by user",
            last_status_at: "now()",
          },
        },
        id: true,
      },
    });

    const matchMapId = String(row.match_map_id);
    if (!row.match_map_demo_id) {
      return;
    }
    const matchMapDemoId = String(row.match_map_demo_id);
    const expectedBatchPodName = GameStreamerService.GetBatchHighlightsJobName(
      matchMapId,
      matchMapDemoId,
    );
    if (String(row.k8s_job_name) !== expectedBatchPodName) {
      return;
    }

    const { clip_render_jobs_aggregate } = await this.hasura.query({
      clip_render_jobs_aggregate: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            match_map_demo_id: { _eq: matchMapDemoId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
          },
        },
        aggregate: { count: true },
      },
    });
    const stillInFlight =
      (clip_render_jobs_aggregate?.aggregate?.count as number | undefined) ?? 0;
    if (stillInFlight > 0) return;

    try {
      const jobs = await this.batchQueue.getJobs([
        "delayed",
        "waiting",
        "active",
        "paused",
      ]);
      for (const queuedJob of jobs) {
        if (
          queuedJob.data?.matchMapId === matchMapId &&
          queuedJob.data?.matchMapDemoId === matchMapDemoId
        ) {
          await queuedJob.remove();
        }
      }
    } catch (error) {
      this.logger.warn(
        `[cancel ${jobId}] BullMQ remove failed: ${(error as Error)?.message}`,
      );
    }

    try {
      await this.gameStreamer.killBatchHighlightsPod(
        matchMapId,
        matchMapDemoId,
      );
    } catch (error) {
      this.logger.warn(
        `[cancel ${jobId}] pod kill failed: ${(error as Error)?.message}`,
      );
    }
  }

  private async findActiveDemoSession(
    userSteamId: string,
    matchMapId: string,
  ): Promise<{
    id: string;
    k8s_job_name: string;
    match_map_demo_id: string | null;
  } | null> {
    const { match_demo_sessions } = await this.hasura.query({
      match_demo_sessions: {
        __args: {
          where: {
            watcher_steam_id: { _eq: userSteamId },
            match_map_id: { _eq: matchMapId },
          },
          limit: 1,
        },
        id: true,
        k8s_job_name: true,
        status: true,
        match_map_demo_id: true,
      },
    });
    const row = match_demo_sessions?.[0];
    if (!row) return null;
    if (row.status !== "playing") return null;
    return {
      id: String(row.id),
      k8s_job_name: String(row.k8s_job_name),
      match_map_demo_id: row.match_map_demo_id
        ? String(row.match_map_demo_id)
        : null,
    };
  }

  public async updateClip(
    userSteamId: string,
    clipId: string,
    patch: {
      title?: string | null;
      visibility?: "private" | "match" | "public";
      target_steam_id?: string | null;
    },
    actorIsOperator = false,
  ): Promise<void> {
    const { match_clips_by_pk: row } = await this.hasura.query({
      match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
        user_steam_id: true,
        match_map_id: true,
      },
    });
    if (!row) {
      throw new Error(`clip ${clipId} not found`);
    }
    if (!actorIsOperator && String(row.user_steam_id) !== String(userSteamId)) {
      throw new Error("you can only edit your own clips");
    }

    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const trimmed = patch.title?.trim() ?? null;
      set.title = trimmed && trimmed.length > 0 ? trimmed : null;
    }
    if (patch.visibility !== undefined) {
      const allowed = ["private", "match", "public"];
      if (!allowed.includes(patch.visibility)) {
        throw new Error(
          `invalid visibility "${patch.visibility}" — must be one of ${allowed.join(", ")}`,
        );
      }
      set.visibility = patch.visibility;
    }
    if (patch.target_steam_id !== undefined) {
      if (patch.target_steam_id === null) {
        set.target_steam_id = null;
      } else {
        const appearsInDemo = await this.targetAppearsInDemo(
          String(row.match_map_id),
          patch.target_steam_id,
        );
        if (!appearsInDemo) {
          throw new Error(
            "target_steam_id must be a player who appears in this match's demo",
          );
        }
        set.target_steam_id = patch.target_steam_id;
      }
    }
    if (Object.keys(set).length === 0) return;

    await this.hasura.mutation({
      update_match_clips_by_pk: {
        __args: { pk_columns: { id: clipId }, _set: set },
        id: true,
      },
    });
  }

  public async incrementClipViews(clipId: string): Promise<void> {
    await this.hasura.mutation({
      update_match_clips_by_pk: {
        __args: { pk_columns: { id: clipId }, _inc: { views_count: 1 } },
        id: true,
      },
    });
  }

  public async incrementClipViewsByFile(file: string): Promise<void> {
    await this.hasura.mutation({
      update_match_clips: {
        __args: {
          where: { file: { _eq: file } },
          _inc: { views_count: 1 },
        },
        affected_rows: true,
      },
    });
  }

  private async targetAppearsInDemo(
    matchMapId: string,
    targetSteamId: string,
    matchMapDemoId?: string,
  ): Promise<boolean> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: matchMapDemoId
            ? { id: { _eq: matchMapDemoId } }
            : { match_map_id: { _eq: matchMapId } },
          order_by: [{ metadata_parsed_at: "desc_nulls_last" }, { id: "desc" }],
          limit: 1,
        },
        players: true,
        kills: true,
      },
    });
    const demo = match_map_demos?.[0];
    if (!demo) return false;
    const players =
      (demo.players as Array<{ steam_id?: string }> | undefined) ?? [];
    if (players.some((p) => String(p?.steam_id ?? "") === targetSteamId)) {
      return true;
    }
    const kills =
      (demo.kills as Array<{ killer?: string; victim?: string }> | undefined) ??
      [];
    return kills.some(
      (k) =>
        String(k?.killer ?? "") === targetSteamId ||
        String(k?.victim ?? "") === targetSteamId,
    );
  }

  public async deleteClip(
    userSteamId: string,
    clipId: string,
    actorIsOperator = false,
  ) {
    const { match_clips_by_pk: row } = await this.hasura.query({
      match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
        user_steam_id: true,
        file: true,
      },
    });
    if (!row) {
      throw new Error(`clip ${clipId} not found`);
    }
    if (!actorIsOperator && String(row.user_steam_id) !== String(userSteamId)) {
      throw new Error("you can only delete your own clips");
    }

    const ownerSteamId = String(row.user_steam_id ?? userSteamId);
    await this.hasura.mutation({
      delete_match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
      },
    });

    try {
      await this.s3.removePrefix(`clips/${ownerSteamId}/${clipId}`);
    } catch (error) {
      this.logger.warn(
        `[clip ${clipId}] s3 remove failed (row already deleted, leaving orphaned objects clips/${ownerSteamId}/${clipId}*): ${(error as Error)?.message}`,
      );
    }
  }

  public async deleteClipsForMatch(matchId: string): Promise<void> {
    const { match_clips } = await this.hasura.query({
      match_clips: {
        __args: {
          where: { match_map: { match_id: { _eq: matchId } } },
        },
        id: true,
        user_steam_id: true,
      },
    });

    for (const clip of match_clips) {
      try {
        await this.s3.removePrefix(`clips/${clip.user_steam_id}/${clip.id}`);
      } catch (error) {
        this.logger.warn(
          `[clip ${clip.id}] failed to remove objects: ${(error as Error)?.message}`,
        );
      }
      await this.hasura.mutation({
        delete_match_clips_by_pk: {
          __args: { id: clip.id },
          __typename: true,
        },
      });
    }
  }

  public async validateClipRenderAuth(
    jobId: string,
    originAuth: unknown,
  ): Promise<{
    id: string;
    user_steam_id: string;
    match_map_id: string;
  } | null> {
    if (!originAuth || typeof originAuth !== "string") return null;
    const colonIndex = originAuth.indexOf(":");
    if (colonIndex === -1) return null;
    const headerJobId = originAuth.substring(0, colonIndex);
    const presentedToken = originAuth.substring(colonIndex + 1);
    if (!timingSafeStringEqual(headerJobId, jobId)) return null;

    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: { id: { _eq: jobId } },
          limit: 1,
        },
        id: true,
        user_steam_id: true,
        match_map_id: true,
        session_token: true,
      },
    });
    const row = clip_render_jobs?.[0];
    if (!row?.session_token) return null;
    if (!timingSafeStringEqual(row.session_token, presentedToken)) return null;

    return {
      id: row.id,
      user_steam_id: String(row.user_steam_id),
      match_map_id: row.match_map_id,
    };
  }

  public async patchClipRenderTitle(jobId: string, title: string) {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        spec: true,
      },
    });
    if (!row) return;
    const prevSpec = (row.spec ?? {}) as Partial<ClipSpec>;
    const nextSpec: Partial<ClipSpec> = { ...prevSpec, title };
    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: {
          pk_columns: { id: jobId },
          _set: { spec: nextSpec },
        },
        id: true,
      },
    });
  }

  public async getClipRenderStatus(
    jobId: string,
  ): Promise<{ status: string } | null> {
    const { clip_render_jobs_by_pk } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        status: true,
      },
    });
    if (!clip_render_jobs_by_pk) return null;
    return { status: String(clip_render_jobs_by_pk.status) };
  }

  public async reportClipRenderStatus(
    jobId: string,
    body: ClipRenderStatusDto,
  ) {
    const { clip_render_jobs_by_pk: current } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        status: true,
        status_history: true,
      },
    });
    if (!current) {
      this.logger.warn(
        `[clip ${jobId}] reportStatus: row missing — was the job cancelled?`,
      );
      return;
    }

    // Boot ticks land in status_history without overwriting `status` —
    // IN_FLIGHT_STATUSES filtering depends on the row status staying queued.
    const isBoot = body.status === "booting";

    const prevHistory = current.status_history as
      | Array<{
          status: string;
          at: string;
          boot_stage?: string;
          boot_progress?: number;
        }>
      | null
      | undefined;
    const nextHistory = Array.isArray(prevHistory) ? [...prevHistory] : [];
    const entry: Record<string, unknown> = {
      status: body.status,
      at: new Date().toISOString(),
    };
    if (isBoot) {
      if (typeof body.boot_stage === "string" && body.boot_stage.length > 0) {
        entry.boot_stage = body.boot_stage.slice(0, 64);
      }
      if (
        typeof body.boot_progress === "number" &&
        Number.isFinite(body.boot_progress)
      ) {
        entry.boot_progress = Math.max(0, Math.min(1, body.boot_progress));
      }
      // Coalesce within-stage ticks; new stage pushes a fresh entry.
      const last = nextHistory[nextHistory.length - 1];
      const lastBootStage =
        last && last.status === "booting"
          ? (last as { boot_stage?: string }).boot_stage
          : undefined;
      const lastStage =
        last && last.status === "booting"
          ? typeof lastBootStage === "string"
            ? lastBootStage.split(":")[0]
            : ""
          : null;
      const newStage =
        typeof entry.boot_stage === "string"
          ? (entry.boot_stage as string).split(":")[0]
          : "";
      if (lastStage !== null && lastStage === newStage) {
        nextHistory[nextHistory.length - 1] = {
          ...last,
          ...entry,
          at: last?.at ?? entry.at,
        } as typeof last;
      } else {
        nextHistory.push(entry as typeof last);
      }
    } else {
      nextHistory.push(entry as { status: string; at: string });
    }
    while (nextHistory.length > STATUS_HISTORY_CAP) nextHistory.shift();

    const set: Record<string, unknown> = {
      status_history: nextHistory,
      last_status_at: "now()",
    };
    if (!isBoot) {
      set.status = body.status;
    }
    if (
      typeof body.progress === "number" &&
      body.progress >= 0 &&
      body.progress <= 1
    ) {
      set.progress = body.progress;
    }
    if (body.error) {
      set.error_message = body.error;
    }
    if (!isBoot && ["completed", "error", "cancelled"].includes(body.status)) {
      // The steam account is held by the batch pod, freed on pod teardown.
      set.game_server_node_id = null;
    }
    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: { pk_columns: { id: jobId }, _set: set },
        id: true,
      },
    });
  }

  private async resolveClipRound(
    matchMapId: string,
    matchMapDemoId: string | null,
    spec: ClipSpec | null,
  ): Promise<number | null> {
    const firstSegment = spec?.segments?.[0];
    if (!firstSegment || typeof firstSegment.start_tick !== "number") {
      return null;
    }

    try {
      const { match_map_demos } = await this.hasura.query({
        match_map_demos: {
          __args: {
            where: matchMapDemoId
              ? { id: { _eq: matchMapDemoId } }
              : { match_map_id: { _eq: matchMapId } },
            order_by: [
              { metadata_parsed_at: "desc_nulls_last" },
              { id: "desc" },
            ],
            limit: 1,
          },
          round_ticks: true,
        },
      });
      const rounds =
        (match_map_demos?.[0]?.round_ticks as
          | Array<{ round: number; start_tick: number; end_tick: number }>
          | undefined) ?? [];
      if (rounds.length === 0) return null;

      const tick = firstSegment.start_tick;
      const hit = rounds.find(
        (r) => tick >= r.start_tick && tick <= r.end_tick,
      );
      if (hit) return hit.round;

      const next = rounds
        .filter((r) => r.start_tick >= tick)
        .sort((a, b) => a.start_tick - b.start_tick)[0];
      return next?.round ?? null;
    } catch (error) {
      this.logger.warn(
        `[clip] round resolve failed for match_map ${matchMapId}: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  private async resolveChipMeta(
    matchMapId: string,
    targetSteamId: string | null,
  ): Promise<{
    mapName: string | null;
    playerName: string | null;
    avatarUrl: string | null;
  }> {
    try {
      const { match_maps_by_pk, players } = await this.hasura.query({
        match_maps_by_pk: {
          __args: { id: matchMapId },
          map: { name: true },
        },
        ...(targetSteamId
          ? {
              players: {
                __args: {
                  where: { steam_id: { _eq: targetSteamId } },
                  limit: 1,
                },
                name: true,
                avatar_url: true,
                custom_avatar_url: true,
              },
            }
          : {}),
      });
      const mapName =
        (match_maps_by_pk?.map?.name as string | undefined) ?? null;
      const player = (players?.[0] ?? null) as {
        name?: string | null;
        avatar_url?: string | null;
        custom_avatar_url?: string | null;
      } | null;
      return {
        mapName,
        playerName: player?.name?.trim() || null,
        avatarUrl:
          player?.custom_avatar_url?.trim() ||
          player?.avatar_url?.trim() ||
          null,
      };
    } catch (error) {
      this.logger.warn(
        `[clip] chip meta resolve failed for match_map ${matchMapId}: ${(error as Error)?.message}`,
      );
      return { mapName: null, playerName: null, avatarUrl: null };
    }
  }

  private async countKillsForSpec(
    matchMapId: string,
    spec: ClipSpec | null,
    targetSteamId: string | null,
  ): Promise<number | null> {
    const segments = spec?.segments ?? [];
    if (segments.length === 0) return null;

    try {
      const { match_map_demos } = await this.hasura.query({
        match_map_demos: {
          __args: { where: { match_map_id: { _eq: matchMapId } }, limit: 1 },
          kills: true,
        },
      });
      const demo = match_map_demos?.[0];
      const kills = ClipsService.filterValidKills(
        demo?.kills as Array<{
          tick: number;
          killer?: string;
          victim?: string;
        }>,
      );
      if (kills.length === 0) return 0;

      let count = 0;
      for (const k of kills) {
        if (typeof k.tick !== "number") continue;
        if (targetSteamId && String(k.killer) !== targetSteamId) continue;
        const inSegment = segments.some(
          (s) => k.tick >= s.start_tick && k.tick <= s.end_tick,
        );
        if (inSegment) count++;
      }
      return count;
    } catch (error) {
      this.logger.warn(
        `[clip] kills count failed for match_map ${matchMapId}: ${(error as Error)?.message}`,
      );
      return null;
    }
  }

  public async uploadClipThumbnail(
    jobId: string,
    fileStream: Readable,
  ): Promise<{ key: string }> {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
        user_steam_id: true,
        status: true,
      },
    });
    if (!row) throw new Error(`clip render ${jobId} not found`);
    if (
      row.status === "cancelled" ||
      row.status === "error" ||
      row.status === "done"
    ) {
      throw new Error(`render is ${row.status}`);
    }

    const userSteamId =
      row.user_steam_id != null ? String(row.user_steam_id) : null;
    const key = ClipsService.GetClipThumbnailS3Key(
      userSteamId ?? "system",
      jobId,
    );

    await this.s3.put(key, fileStream);

    return { key };
  }

  public async finalizeClipUpload(
    jobId: string,
    fileStream: Readable,
    durationMs: number | null,
  ): Promise<{ clipId: string; file: string }> {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
        user_steam_id: true,
        match_map_id: true,
        match_map_demo_id: true,
        spec: true,
        status: true,
      },
    });
    if (!row) throw new Error(`clip render ${jobId} not found`);
    if (
      row.status === "cancelled" ||
      row.status === "error" ||
      row.status === "done"
    ) {
      throw new Error(`render is ${row.status}`);
    }

    const userSteamId =
      row.user_steam_id != null ? String(row.user_steam_id) : null;
    const key = ClipsService.GetClipS3Key(userSteamId ?? "system", jobId);

    await this.s3.put(key, fileStream);

    let videoSize = 0;
    try {
      videoSize = (await this.s3.stat(key))?.size ?? 0;
    } catch (error) {
      this.logger.warn(
        `[clip ${jobId}] video stat failed: ${(error as Error)?.message}`,
      );
    }

    const thumbnailKey = ClipsService.GetClipThumbnailS3Key(
      userSteamId ?? "system",
      jobId,
    );
    let thumbnailUrl: string | null = null;
    let thumbnailSize = 0;
    try {
      if (await this.s3.has(thumbnailKey)) {
        thumbnailUrl = thumbnailKey;
        try {
          thumbnailSize = (await this.s3.stat(thumbnailKey))?.size ?? 0;
        } catch (error) {
          this.logger.warn(
            `[clip ${jobId}] thumbnail stat failed: ${(error as Error)?.message}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `[clip ${jobId}] thumbnail existence check failed: ${(error as Error)?.message}`,
      );
    }

    const spec = row.spec as unknown as ClipSpec;
    const title = spec?.title ?? null;
    const rawTarget = spec?.segments?.[0]?.pov_steam_id ?? null;
    let targetSteamId: string | null = null;
    if (rawTarget) {
      const { players } = await this.hasura.query({
        players: {
          __args: {
            where: { steam_id: { _eq: rawTarget } },
            limit: 1,
          },
          steam_id: true,
        },
      });
      if (players?.[0]?.steam_id) {
        targetSteamId = String(players[0].steam_id);
      } else if (spec?.target_name) {
        try {
          await this.hasura.mutation({
            insert_players: {
              __args: {
                objects: [
                  {
                    steam_id: rawTarget,
                    name: spec.target_name,
                    role: "user" as e_player_roles_enum,
                  },
                ],
                on_conflict: {
                  constraint: "players_pkey",
                  update_columns: [],
                },
              },
              affected_rows: true,
            },
          });
          targetSteamId = String(rawTarget);
        } catch (error) {
          this.logger.warn(
            `[clip ${jobId}] target steam_id ${rawTarget} upsert failed (${(error as Error)?.message}) — leaving target_steam_id null`,
          );
        }
      } else {
        this.logger.log(
          `[clip ${jobId}] target steam_id ${rawTarget} not in players table and spec has no target_name — leaving target_steam_id null`,
        );
      }
    }

    const visibility = spec?.visibility ?? "private";

    const killsCount = await this.countKillsForSpec(
      row.match_map_id,
      spec,
      targetSteamId,
    );

    const round = await this.resolveClipRound(
      row.match_map_id,
      row.match_map_demo_id ? String(row.match_map_demo_id) : null,
      spec,
    );

    const { insert_match_clips_one } = await this.hasura.mutation({
      insert_match_clips_one: {
        __args: {
          object: {
            ...(userSteamId ? { user_steam_id: userSteamId } : {}),
            target_steam_id: targetSteamId,
            match_map_id: row.match_map_id,
            match_map_demo_id: row.match_map_demo_id ?? null,
            title,
            duration_ms: durationMs,
            file: key,
            thumbnail_url: thumbnailUrl,
            kills_count: killsCount,
            round,
            visibility,
            size: videoSize + thumbnailSize,
          },
        },
        id: true,
      },
    });
    const clipId = insert_match_clips_one?.id;
    if (!clipId) throw new Error("failed to insert match_clips row");

    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: {
          pk_columns: { id: jobId },
          _set: {
            status: "done",
            progress: 1,
            clip_id: clipId,
            last_status_at: "now()",
          },
        },
        id: true,
      },
    });

    return { clipId, file: key };
  }

  private async findInFlightForUser(userSteamId: string) {
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            user_steam_id: { _eq: userSteamId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
            _not: { k8s_job_name: { _like: "gs-batch-%" } },
          },
          limit: 1,
        },
        id: true,
        status: true,
      },
    });
    return clip_render_jobs?.[0] ?? null;
  }

  public async autoGenerateForDemo(
    matchId: string,
    matchMapId: string,
    matchMapDemoId: string,
    options: {
      force?: boolean;
      isSystemInitiated?: boolean;
      actingUserSteamId?: string;
    } = {},
  ): Promise<number> {
    if (!options.force) {
      const enabled = await this.readBoolSetting(
        "auto_generate_match_clips",
        false,
      );
      if (!enabled) return 0;

      const { matches_by_pk } = await this.hasura.query({
        matches_by_pk: { __args: { id: matchId }, source: true },
      });
      if (!(await this.importedAutoClipsAllowed(matches_by_pk?.source))) {
        this.logger.log(
          `[auto-clips] demo ${matchMapDemoId} skipped: imported-match auto highlights disabled (source=${matches_by_pk?.source})`,
        );
        return 0;
      }
    }
    if (!(await this.hasGpuNode())) {
      const msg =
        "no GPU node registered — auto-clips need a GPU node to exist (offline is fine, jobs will queue and dispatch once it's back online)";
      if (options.force) {
        throw new Error(msg);
      }
      this.logger.log(`[auto-clips] demo ${matchMapDemoId} skipped: ${msg}`);
      return 0;
    }

    const defaultVisibility = await this.readSetting(
      "auto_clip_default_visibility",
      "public",
    );

    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: { where: { id: { _eq: matchMapDemoId } }, limit: 1 },
        id: true,
        match_map_id: true,
        kills: true,
        players: true,
        tick_rate: true,
        total_ticks: true,
        round_ticks: true,
        metadata_parsed_at: true,
      },
    });
    const demo = match_map_demos?.[0];
    if (!demo) {
      this.logger.warn(
        `[auto-clips] demo ${matchMapDemoId} not found for match ${matchId}`,
      );
      return 0;
    }
    if (String(demo.match_map_id) !== matchMapId) {
      this.logger.warn(
        `[auto-clips] demo ${matchMapDemoId} match_map mismatch (got ${demo.match_map_id}, expected ${matchMapId})`,
      );
      return 0;
    }
    if (!demo.metadata_parsed_at || !demo.total_ticks) {
      return 0;
    }

    const { delete_clip_render_jobs } = await this.hasura.mutation({
      delete_clip_render_jobs: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            match_map_demo_id: { _eq: matchMapDemoId },
          },
        },
        affected_rows: true,
      },
    });
    const removed =
      (delete_clip_render_jobs?.affected_rows as number | undefined) ?? 0;
    if (removed > 0) {
      this.logger.log(
        `[auto-clips] demo ${matchMapDemoId} cleared ${removed} prior clip_render_jobs row(s) before re-queue`,
      );
    }

    const kills = ClipsService.filterValidKills(
      demo.kills as
        | Array<{ tick?: number; killer?: string; victim?: string }>
        | undefined,
    );
    if (kills.length === 0) return 0;

    const rawKillers = new Set<string>();
    for (const k of kills) {
      if (k.killer) {
        rawKillers.add(k.killer);
      }
    }
    const killers = await this.filterLoggedInSteamIds(rawKillers);
    if (killers.size === 0) {
      this.logger.log(
        `[auto-clips] demo ${matchMapDemoId} skipped: no killers have logged in to the platform`,
      );
      return 0;
    }
    const filteredOut = rawKillers.size - killers.size;
    if (filteredOut > 0) {
      this.logger.log(
        `[auto-clips] demo ${matchMapDemoId} skipping ${filteredOut} killer(s) without platform login`,
      );
    }

    const players =
      (demo.players as
        | Array<{ steam_id?: string; name?: string }>
        | undefined) ?? [];
    const nameByStId = new Map<string, string>();
    for (const p of players) {
      if (p?.steam_id && p?.name) {
        nameByStId.set(String(p.steam_id), String(p.name));
      }
    }

    const upsertObjects: Array<{
      steam_id: string;
      name: string;
      role: e_player_roles_enum;
    }> = [];
    for (const sid of killers) {
      const name = nameByStId.get(sid);
      if (!name) continue;
      upsertObjects.push({
        steam_id: sid,
        name,
        role: "user" as e_player_roles_enum,
      });
    }
    if (upsertObjects.length > 0) {
      try {
        await this.hasura.mutation({
          insert_players: {
            __args: {
              objects: upsertObjects,
              on_conflict: {
                constraint: "players_pkey",
                update_columns: [],
              },
            },
            affected_rows: true,
          },
        });
      } catch (error) {
        this.logger.warn(
          `[auto-clips] demo ${matchMapDemoId} player upsert failed: ${(error as Error)?.message}`,
        );
      }
    }

    const pendingObjects: Array<{
      targetSteamId: string;
      sessionToken: string;
      spec: ClipSpec;
    }> = [];
    for (const targetSteamId of killers) {
      try {
        const baseSpec = await this.buildPresetSpec(
          matchMapId,
          targetSteamId,
          "best_round",
          { resolution: "1080p", fps: 60 },
          undefined,
          nameByStId.get(targetSteamId),
          matchMapDemoId,
        );
        const spec: ClipSpec = {
          ...baseSpec,
          destination: "library",
          visibility: defaultVisibility as ClipSpec["visibility"],
        };
        pendingObjects.push({
          targetSteamId,
          sessionToken: randomBytes(24).toString("hex"),
          spec,
        });
      } catch (error) {
        this.logger.warn(
          `[auto-clips] demo ${matchMapDemoId} target ${targetSteamId} skipped: ${(error as Error)?.message}`,
        );
      }
    }

    if (pendingObjects.length === 0) return 0;
    const orderedPendingObjects =
      ClipsService.orderHighlightJobs(pendingObjects);

    const insertObjects = orderedPendingObjects.map((p, index) => ({
      user_steam_id: options.isSystemInitiated
        ? null
        : options.actingUserSteamId
          ? String(options.actingUserSteamId)
          : null,
      match_map_id: matchMapId,
      match_map_demo_id: matchMapDemoId,
      session_token: p.sessionToken,
      k8s_job_name: GameStreamerService.GetBatchHighlightsJobName(
        matchMapId,
        matchMapDemoId,
      ),
      spec: p.spec,
      status: "queued",
      sort_index: index,
      status_history: [
        {
          status: "queued",
          at: new Date().toISOString(),
          source: "auto_generate_match_clips",
          target_steam_id: p.targetSteamId,
          match_map_demo_id: matchMapDemoId,
          default_visibility: defaultVisibility,
        },
      ],
    }));

    let queued = 0;
    try {
      const { insert_clip_render_jobs } = await this.hasura.mutation({
        insert_clip_render_jobs: {
          __args: { objects: insertObjects },
          returning: { id: true },
        },
      });
      queued = (
        (insert_clip_render_jobs?.returning as Array<{ id: string }>) ?? []
      ).length;
    } catch (error) {
      this.logger.warn(
        `[auto-clips] demo ${matchMapDemoId} batch insert failed: ${(error as Error)?.message}`,
      );
      return 0;
    }

    try {
      await this.batchQueue.add(
        BATCH_HIGHLIGHTS_JOB_NAME,
        { matchMapId, matchMapDemoId },
        { jobId: `${matchMapId}-${matchMapDemoId}-${Date.now()}` },
      );
      this.logger.log(
        `[auto-clips] demo ${matchMapDemoId} → enqueued batch highlights (${queued} job(s), default visibility=${defaultVisibility})`,
      );
    } catch (error) {
      this.logger.warn(
        `[auto-clips] demo ${matchMapDemoId} enqueue failed: ${(error as Error)?.message}`,
      );
    }

    return queued;
  }

  public async autoGenerateForMatch(
    matchId: string,
    options: {
      force?: boolean;
      isSystemInitiated?: boolean;
      actingUserSteamId?: string;
    } = {},
  ): Promise<number> {
    if (!options.force) {
      const enabled = await this.readBoolSetting(
        "auto_generate_match_clips",
        false,
      );
      if (!enabled) return 0;
    }
    if (!(await this.hasGpuNode())) {
      const msg =
        "no GPU node registered — auto-clips need a GPU node to exist (offline is fine, jobs will queue and dispatch once it's back online)";
      if (options.force) {
        throw new Error(msg);
      }
      this.logger.log(`[auto-clips] match ${matchId} skipped: ${msg}`);
      return 0;
    }

    const defaultVisibility = await this.readSetting(
      "auto_clip_default_visibility",
      "public",
    );

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        source: true,
        match_maps: {
          id: true,
          demos: {
            id: true,
            kills: true,
            players: true,
            tick_rate: true,
            total_ticks: true,
            round_ticks: true,
            metadata_parsed_at: true,
          },
        },
      },
    });
    if (!match) {
      this.logger.warn(`[auto-clips] match ${matchId} not found`);
      return 0;
    }
    if (
      !options.force &&
      !(await this.importedAutoClipsAllowed(
        (match as { source?: string }).source,
      ))
    ) {
      this.logger.log(
        `[auto-clips] match ${matchId} skipped: imported-match auto highlights disabled (source=${(match as { source?: string }).source})`,
      );
      return 0;
    }

    const matchMapIds = (match.match_maps ?? []).map((m: any) => String(m.id));
    if (matchMapIds.length > 0) {
      const { delete_clip_render_jobs } = await this.hasura.mutation({
        delete_clip_render_jobs: {
          __args: { where: { match_map_id: { _in: matchMapIds } } },
          affected_rows: true,
        },
      });
      const removed =
        (delete_clip_render_jobs?.affected_rows as number | undefined) ?? 0;
      if (removed > 0) {
        this.logger.log(
          `[auto-clips] match ${matchId} cleared ${removed} prior clip_render_jobs row(s) before re-queue`,
        );
      }
    }

    let queued = 0;
    const perDemo = new Map<
      string,
      {
        matchMapId: string;
        matchMapDemoId: string;
        jobs: Array<{ job_id: string; session_token: string; spec: ClipSpec }>;
      }
    >();

    const parsedDemosByMap = new Map<string, any[]>();
    for (const mapRow of match.match_maps ?? []) {
      const parsed = (mapRow.demos ?? []).filter(
        (d: any) => d?.metadata_parsed_at && d?.total_ticks,
      );
      if (parsed.length > 0) parsedDemosByMap.set(String(mapRow.id), parsed);
    }

    const rawKillers = new Set<string>();
    for (const demos of parsedDemosByMap.values()) {
      for (const demo of demos) {
        const kills = ClipsService.filterValidKills(
          demo?.kills as
            | Array<{ killer?: string; victim?: string }>
            | undefined,
        );
        for (const k of kills) {
          if (k.killer) {
            rawKillers.add(k.killer);
          }
        }
      }
    }
    const allKillers = await this.filterLoggedInSteamIds(rawKillers);
    if (allKillers.size === 0) {
      this.logger.log(
        `[auto-clips] match ${matchId} skipped: no killers have logged in to the platform`,
      );
      return 0;
    }
    const filteredOut = rawKillers.size - allKillers.size;
    if (filteredOut > 0) {
      this.logger.log(
        `[auto-clips] match ${matchId} skipping ${filteredOut} killer(s) without platform login`,
      );
    }

    const buildNameMapFromMatch = (m: any) => {
      const out = new Map<string, string>();
      for (const mapRow of m.match_maps ?? []) {
        for (const demo of mapRow.demos ?? []) {
          const demoPlayers =
            (demo?.players as
              | Array<{ steam_id?: string; name?: string }>
              | undefined) ?? [];
          for (const p of demoPlayers) {
            if (p?.steam_id && p?.name) {
              out.set(String(p.steam_id), String(p.name));
            }
          }
        }
      }
      return out;
    };

    const nameByStId = buildNameMapFromMatch(match);
    const unresolved = Array.from(allKillers).filter(
      (sid) => !nameByStId.has(sid),
    );

    if (unresolved.length > 0) {
      this.logger.warn(
        `[auto-clips] match ${matchId} missing ${unresolved.length} killer name(s) from already-parsed demo.players (${unresolved.join(", ")}) — clips for these will queue as "Player NNNN" (skipping re-parse)`,
      );
    }

    const upsertObjects: Array<{
      steam_id: string;
      name: string;
      role: e_player_roles_enum;
    }> = [];
    for (const sid of allKillers) {
      const name = nameByStId.get(sid);
      if (!name) continue;
      upsertObjects.push({
        steam_id: sid,
        name,
        role: "user" as e_player_roles_enum,
      });
    }
    if (upsertObjects.length > 0) {
      try {
        await this.hasura.mutation({
          insert_players: {
            __args: {
              objects: upsertObjects,
              on_conflict: {
                constraint: "players_pkey",
                update_columns: [],
              },
            },
            affected_rows: true,
          },
        });
      } catch (error) {
        this.logger.warn(
          `[auto-clips] match ${matchId} player upsert failed: ${(error as Error)?.message}`,
        );
      }
    }

    const pendingObjects: Array<{
      mapRowId: string;
      matchMapDemoId: string;
      targetSteamId: string;
      sessionToken: string;
      spec: ClipSpec;
    }> = [];
    for (const [mapRowId, demos] of parsedDemosByMap) {
      for (const demo of demos) {
        const kills = ClipsService.filterValidKills(
          demo?.kills as
            | Array<{ tick?: number; killer?: string; victim?: string }>
            | undefined,
        );
        if (kills.length === 0) {
          continue;
        }

        const killers = new Set<string>();
        for (const k of kills) {
          if (k.killer && allKillers.has(k.killer)) {
            killers.add(k.killer);
          }
        }

        for (const targetSteamId of killers) {
          try {
            const baseSpec = await this.buildPresetSpec(
              mapRowId,
              targetSteamId,
              "best_round",
              { resolution: "1080p", fps: 60 },
              undefined,
              nameByStId.get(targetSteamId),
              String(demo.id),
            );
            const spec: ClipSpec = {
              ...baseSpec,
              destination: "library",
              visibility: defaultVisibility as ClipSpec["visibility"],
            };
            pendingObjects.push({
              mapRowId,
              matchMapDemoId: String(demo.id),
              targetSteamId,
              sessionToken: randomBytes(24).toString("hex"),
              spec,
            });
          } catch (error) {
            this.logger.warn(
              `[auto-clips] match ${matchId} map ${mapRowId} demo ${demo.id} target ${targetSteamId} skipped: ${(error as Error)?.message}`,
            );
          }
        }
      }
    }

    if (pendingObjects.length > 0) {
      const orderedPendingObjects = [...pendingObjects].sort((a, b) => {
        const aKey = `${a.mapRowId}:${a.matchMapDemoId}`;
        const bKey = `${b.mapRowId}:${b.matchMapDemoId}`;
        if (aKey !== bKey) return aKey.localeCompare(bKey);
        return ClipsService.compareHighlightJobs(a, b);
      });
      const indexByDemoKey = new Map<string, number>();
      const insertObjects = orderedPendingObjects.map((p) => {
        const key = `${p.mapRowId}:${p.matchMapDemoId}`;
        const idx = indexByDemoKey.get(key) ?? 0;
        indexByDemoKey.set(key, idx + 1);
        return {
          user_steam_id: options.isSystemInitiated
            ? null
            : options.actingUserSteamId
              ? String(options.actingUserSteamId)
              : null,
          match_map_id: p.mapRowId,
          match_map_demo_id: p.matchMapDemoId,
          session_token: p.sessionToken,
          k8s_job_name: GameStreamerService.GetBatchHighlightsJobName(
            p.mapRowId,
            p.matchMapDemoId,
          ),
          spec: p.spec,
          status: "queued",
          sort_index: idx,
          status_history: [
            {
              status: "queued",
              at: new Date().toISOString(),
              source: "auto_generate_match_clips",
              target_steam_id: p.targetSteamId,
              match_map_demo_id: p.matchMapDemoId,
              default_visibility: defaultVisibility,
            },
          ],
        };
      });
      try {
        const { insert_clip_render_jobs } = await this.hasura.mutation({
          insert_clip_render_jobs: {
            __args: { objects: insertObjects },
            returning: {
              id: true,
              match_map_id: true,
              match_map_demo_id: true,
              session_token: true,
            },
          },
        });
        const returning =
          (insert_clip_render_jobs?.returning as
            | Array<{
                id: string;
                match_map_id: string;
                match_map_demo_id: string;
                session_token: string;
              }>
            | undefined) ?? [];
        const pendingByToken = new Map(
          orderedPendingObjects.map((p) => [p.sessionToken, p]),
        );
        for (const inserted of returning) {
          if (!inserted?.id || !inserted?.session_token) continue;
          const pending = pendingByToken.get(inserted.session_token);
          if (!pending) continue;
          const key = `${inserted.match_map_id}:${inserted.match_map_demo_id}`;
          const entry = perDemo.get(key) ?? {
            matchMapId: String(inserted.match_map_id),
            matchMapDemoId: String(inserted.match_map_demo_id),
            jobs: [],
          };
          entry.jobs.push({
            job_id: String(inserted.id),
            session_token: pending.sessionToken,
            spec: pending.spec,
          });
          perDemo.set(key, entry);
          queued++;
        }
      } catch (error) {
        this.logger.warn(
          `[auto-clips] match ${matchId} batch insert failed: ${(error as Error)?.message}`,
        );
      }
    }

    this.logger.log(
      `[auto-clips] match ${matchId} queued ${queued} recap job(s) across ${perDemo.size} demo(s) (default visibility=${defaultVisibility})`,
    );

    for (const { matchMapId, matchMapDemoId } of perDemo.values()) {
      try {
        await this.batchQueue.add(
          BATCH_HIGHLIGHTS_JOB_NAME,
          { matchMapId, matchMapDemoId },
          { jobId: `${matchMapId}-${matchMapDemoId}-${Date.now()}` },
        );
        this.logger.log(
          `[auto-clips] match ${matchId} map ${matchMapId} demo ${matchMapDemoId} → enqueued batch highlights`,
        );
      } catch (error) {
        this.logger.warn(
          `[auto-clips] match ${matchId} map ${matchMapId} demo ${matchMapDemoId} enqueue failed: ${(error as Error)?.message}`,
        );
      }
    }
    return queued;
  }

  private async filterLoggedInSteamIds(
    steamIds: Iterable<string>,
  ): Promise<Set<string>> {
    const ids = Array.from(new Set(steamIds));
    if (ids.length === 0) {
      return new Set();
    }
    const { players } = await this.hasura.query({
      players: {
        __args: {
          where: {
            steam_id: { _in: ids },
            last_sign_in_at: { _is_null: false },
          },
        },
        steam_id: true,
      },
    });
    return new Set(
      ((players ?? []) as Array<{ steam_id: string | number }>).map((p) =>
        String(p.steam_id),
      ),
    );
  }

  private async hasGpuNode(): Promise<boolean> {
    const { game_server_nodes_aggregate } = await this.hasura.query({
      game_server_nodes_aggregate: {
        __args: { where: { gpu: { _eq: true } } },
        aggregate: { count: true },
      },
    });
    return (game_server_nodes_aggregate?.aggregate?.count ?? 0) > 0;
  }

  public async reconcileQueuedHighlights(): Promise<number> {
    await this.reapOrphanResourceClaims();

    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            status: { _eq: "queued" },
            k8s_job_name: { _like: "gs-batch-%" },
            match_map_demo_id: { _is_null: false },
          },
          distinct_on: ["match_map_id", "match_map_demo_id"],
          order_by: [
            { match_map_id: "asc" },
            { match_map_demo_id: "asc" },
            { created_at: "asc" },
          ],
        },
        match_map_id: true,
        match_map_demo_id: true,
      },
    });

    const rows = clip_render_jobs ?? [];
    if (rows.length === 0) return 0;

    const liveStates: Array<
      "delayed" | "waiting" | "active" | "paused" | "waiting-children"
    > = ["delayed", "waiting", "active", "paused", "waiting-children"];
    const queuedBullMqJobs = await this.batchQueue.getJobs(liveStates);
    const jobsByPair = new Map<string, typeof queuedBullMqJobs>();
    for (const j of queuedBullMqJobs) {
      if (j.name !== BATCH_HIGHLIGHTS_JOB_NAME) continue;
      const data = (j.data ?? {}) as {
        matchMapId?: string;
        matchMapDemoId?: string;
      };
      if (!data.matchMapId || !data.matchMapDemoId) continue;
      const key = `${data.matchMapId}:${data.matchMapDemoId}`;
      const bucket = jobsByPair.get(key) ?? [];
      bucket.push(j);
      jobsByPair.set(key, bucket);
    }

    let touched = 0;
    for (const row of rows) {
      const mmId = row.match_map_id ? String(row.match_map_id) : null;
      const mmDemoId = row.match_map_demo_id
        ? String(row.match_map_demo_id)
        : null;
      if (!mmId || !mmDemoId) continue;
      const key = `${mmId}:${mmDemoId}`;
      const companions = jobsByPair.get(key) ?? [];

      if (companions.length === 0) {
        try {
          await this.batchQueue.add(
            BATCH_HIGHLIGHTS_JOB_NAME,
            { matchMapId: mmId, matchMapDemoId: mmDemoId },
            { jobId: `${mmId}-${mmDemoId}-reconcile-${Date.now()}` },
          );
          touched++;
          this.logger.log(
            `[reconcile-highlights] re-enqueued orphaned batch for ${key}`,
          );
        } catch (error) {
          this.logger.warn(
            `[reconcile-highlights] enqueue failed for ${key}: ${(error as Error)?.message}`,
          );
        }
        continue;
      }

      for (const companion of companions) {
        let state: string | null = null;
        try {
          state = await companion.getState();
        } catch (error) {
          this.logger.warn(
            `[reconcile-highlights] getState failed for ${key} job ${companion.id}: ${(error as Error)?.message}`,
          );
          continue;
        }
        if (state !== "delayed") continue;
        try {
          await companion.promote();
          touched++;
          this.logger.log(
            `[reconcile-highlights] promoted delayed batch for ${key} (job ${companion.id})`,
          );
        } catch (error) {
          this.logger.warn(
            `[reconcile-highlights] promote failed for ${key} job ${companion.id}: ${(error as Error)?.message}`,
          );
        }
      }
    }
    if (touched > 0) {
      this.logger.log(
        `[reconcile-highlights] touched ${touched} batch job(s) (enqueued + promoted)`,
      );
    }
    return touched;
  }

  private async reapOrphanResourceClaims(): Promise<void> {
    const rows = await this.postgres.query<
      Array<{ match_map_id: string; match_map_demo_id: string }>
    >(
      `SELECT DISTINCT match_map_id::text AS match_map_id,
                       match_map_demo_id::text AS match_map_demo_id
         FROM public.clip_render_jobs
        WHERE status IN ('queued','rendering','uploading')
          AND match_map_demo_id IS NOT NULL
          AND game_server_node_id IS NOT NULL`,
    );
    if (rows.length === 0) {
      return;
    }

    const livePairs = new Set<string>();
    const liveStates: Array<
      "delayed" | "waiting" | "active" | "paused" | "waiting-children"
    > = ["delayed", "waiting", "active", "paused", "waiting-children"];
    const bullJobs = await this.batchQueue.getJobs(liveStates);
    for (const j of bullJobs) {
      if (j.name !== BATCH_HIGHLIGHTS_JOB_NAME) {
        continue;
      }
      const d = (j.data ?? {}) as {
        matchMapId?: string;
        matchMapDemoId?: string;
      };
      if (d.matchMapId && d.matchMapDemoId) {
        livePairs.add(`${d.matchMapId}:${d.matchMapDemoId}`);
      }
    }

    const orphanIds: { matchMapId: string; matchMapDemoId: string }[] = [];
    for (const row of rows) {
      const key = `${row.match_map_id}:${row.match_map_demo_id}`;
      if (livePairs.has(key)) {
        continue;
      }
      const podState = await this.gameStreamer
        .getBatchHighlightsPodState(row.match_map_id, row.match_map_demo_id)
        .catch(() => "absent" as const);
      if (podState === "absent") {
        orphanIds.push({
          matchMapId: row.match_map_id,
          matchMapDemoId: row.match_map_demo_id,
        });
      }
    }

    for (const o of orphanIds) {
      await this.postgres.query(
        `UPDATE public.clip_render_jobs
            SET game_server_node_id = NULL
          WHERE match_map_id = $1::uuid
            AND match_map_demo_id = $2::uuid
            AND status IN ('queued','rendering','uploading')`,
        [o.matchMapId, o.matchMapDemoId],
      );
      await this.steamAccounts.release(
        GameStreamerService.GetBatchHighlightsJobName(
          o.matchMapId,
          o.matchMapDemoId,
        ),
      );
      this.logger.log(
        `[reconcile-highlights] reaped orphan resource claims for ${o.matchMapId}:${o.matchMapDemoId}`,
      );
      try {
        await this.batchQueue.add(
          BATCH_HIGHLIGHTS_JOB_NAME,
          { matchMapId: o.matchMapId, matchMapDemoId: o.matchMapDemoId },
          { jobId: `${o.matchMapId}-${o.matchMapDemoId}-reap-${Date.now()}` },
        );
        this.logger.log(
          `[reconcile-highlights] re-armed batch watchdog for orphaned in-flight ${o.matchMapId}:${o.matchMapDemoId}`,
        );
      } catch (error) {
        this.logger.warn(
          `[reconcile-highlights] re-arm enqueue failed for ${o.matchMapId}:${o.matchMapDemoId}: ${(error as Error)?.message}`,
        );
      }
    }
  }

  private async readSetting(name: string, fallback: string): Promise<string> {
    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: { name },
        value: true,
      },
    });
    return settings_by_pk?.value ?? fallback;
  }

  private async readBoolSetting(
    name: string,
    fallback: boolean,
  ): Promise<boolean> {
    const raw = await this.readSetting(name, fallback ? "true" : "false");
    return raw === "true" || raw === "1";
  }

  // Imported (non-5stack) matches only get auto highlights when the operator
  // has explicitly opted in, separately from the main auto-highlights toggle.
  private async importedAutoClipsAllowed(
    source: string | null | undefined,
  ): Promise<boolean> {
    if (!source || source === "5stack") {
      return true;
    }
    return this.readBoolSetting("auto_generate_match_clips_imported", false);
  }

  public async buildPresetSpec(
    matchMapId: string,
    targetSteamId: string,
    preset: "knife" | "multikills" | "best_round" | "recap",
    output: { resolution: "720p" | "1080p"; fps: 30 | 60 } = {
      resolution: "1080p",
      fps: 60,
    },
    title?: string,
    targetName?: string,
    matchMapDemoId?: string,
  ): Promise<ClipSpec> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: matchMapDemoId
            ? { id: { _eq: matchMapDemoId } }
            : { match_map_id: { _eq: matchMapId } },
          order_by: [{ metadata_parsed_at: "desc_nulls_last" }, { id: "desc" }],
          limit: 1,
        },
        id: true,
        tick_rate: true,
        total_ticks: true,
        kills: true,
        round_ticks: true,
      },
    });
    const demo = match_map_demos?.[0];
    if (!demo) {
      throw new Error(
        `no parsed demo for match_map ${matchMapId} — try opening the demo first to trigger parse`,
      );
    }
    const tickRate = (demo.tick_rate as number) || 64;
    const totalTicks = (demo.total_ticks as number) || 0;
    const kills = ClipsService.filterValidKills(
      demo.kills as Array<{
        tick: number;
        killer?: string;
        victim?: string;
        weapon?: string;
        headshot?: boolean;
      }>,
    );
    const rounds =
      (demo.round_ticks as Array<{
        round: number;
        start_tick: number;
        freeze_end_tick?: number;
        end_tick: number;
      }>) ?? [];

    const myKills = kills.filter((k) => k.killer === targetSteamId);
    const lead = Math.round(tickRate * 3);
    const tail = Math.round(tickRate * 2);
    const CLUSTER_GAP_SECS = 10;
    const clusterGapTicks = Math.round(tickRate * CLUSTER_GAP_SECS);
    // Demo's total_ticks is the literal last observed tick — i.e. gameover.
    // Playing a segment up to that tick triggers the engine's gameover
    // transition and auto-closes the demo, breaking every subsequent job
    // in the same batch. Hold segments a few seconds short of demo end.
    const SAFETY_SECS = 3;
    const safetyTicks = Math.round(tickRate * SAFETY_SECS);
    const maxClipEnd = totalTicks > 0 ? totalTicks - safetyTicks : 0;
    const clamp = (t: number) =>
      Math.max(0, maxClipEnd > 0 ? Math.min(t, maxClipEnd) : t);
    const MIN_SEGMENT_TICKS = Math.round(tickRate * 1.5);
    const segmentIsViable = (s: { start_tick: number; end_tick: number }) =>
      s.end_tick - s.start_tick >= MIN_SEGMENT_TICKS;

    const clusterKills = (ks: Array<{ tick: number }>): ClipSegmentSpec[] => {
      if (ks.length === 0) return [];
      const sorted = [...ks].sort((a, b) => a.tick - b.tick);
      const out: ClipSegmentSpec[] = [];
      let clusterStart = sorted[0].tick;
      let clusterEnd = sorted[0].tick;
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i].tick - clusterEnd;
        if (gap <= clusterGapTicks) {
          clusterEnd = sorted[i].tick;
          continue;
        }
        out.push({
          start_tick: clamp(clusterStart - lead),
          end_tick: clamp(clusterEnd + tail),
          kill_tick: clusterEnd,
        });
        clusterStart = sorted[i].tick;
        clusterEnd = sorted[i].tick;
      }
      out.push({
        start_tick: clamp(clusterStart - lead),
        end_tick: clamp(clusterEnd + tail),
        kill_tick: clusterEnd,
      });
      return out;
    };

    let segments: ClipSegmentSpec[] = [];
    const stats = {
      knifeKills: 0,
      multiKillBuckets: { 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>,
      bestRoundKills: 0,
      recapKills: 0,
      usedFallback: false,
    };

    // freeze_end_tick > 0 — parser uses omitempty so a zero freeze
    // tick serializes as missing; >0 keeps that case on start_tick.
    const roundKillWindow = (r: {
      start_tick: number;
      freeze_end_tick?: number;
      end_tick: number;
    }) => {
      const lo =
        typeof r.freeze_end_tick === "number" && r.freeze_end_tick > 0
          ? r.freeze_end_tick
          : r.start_tick;
      return { lo, hi: r.end_tick };
    };

    if (preset === "knife") {
      const knife = myKills.filter((k) =>
        (k.weapon ?? "").toLowerCase().includes("knife"),
      );
      stats.knifeKills = knife.length;
      segments = knife.map((k) => ({
        start_tick: clamp(k.tick - lead),
        end_tick: clamp(k.tick + tail),
        kill_tick: k.tick,
      }));
    } else if (preset === "multikills") {
      for (const r of rounds) {
        const { lo, hi } = roundKillWindow(r);
        const inRound = myKills.filter((k) => k.tick >= lo && k.tick <= hi);
        if (inRound.length < 2) continue;
        const bucket = Math.min(5, inRound.length);
        stats.multiKillBuckets[bucket] =
          (stats.multiKillBuckets[bucket] ?? 0) + 1;
        segments.push(...clusterKills(inRound));
      }
    } else if (preset === "best_round") {
      // Build all viable candidates so that if the kill-leader round
      // happens to be the final round (kills land past the safety
      // margin), we naturally fall through to the next-best round
      // instead of producing an empty/unrenderable clip.
      const candidates: Array<{
        count: number;
        span: number;
        segs: ClipSegmentSpec[];
      }> = [];
      for (const r of rounds) {
        const { lo, hi } = roundKillWindow(r);
        const inRound = myKills
          .filter((k) => k.tick >= lo && k.tick <= hi)
          .sort((a, b) => a.tick - b.tick);
        const count = inRound.length;
        if (count === 0) continue;
        const roundCap = hi > 0 ? hi : maxClipEnd;
        const segs = clusterKills(inRound)
          .map((s) => ({
            start_tick: s.start_tick,
            end_tick: Math.min(s.end_tick, roundCap),
            ...(s.kill_tick != null ? { kill_tick: s.kill_tick } : {}),
          }))
          .filter(segmentIsViable);
        if (segs.length === 0) continue;
        const span = count >= 2 ? inRound[count - 1].tick - inRound[0].tick : 0;
        candidates.push({ count, span, segs });
      }
      candidates.sort((a, b) => b.count - a.count || a.span - b.span);
      if (candidates.length > 0) {
        stats.bestRoundKills = candidates[0].count;
        segments = candidates[0].segs;
      }
    } else if (preset === "recap") {
      segments = clusterKills(myKills);
      stats.recapKills = myKills.length;
    }

    if (segments.length === 0 && myKills.length > 0) {
      const fallback = myKills.find((k) => k.headshot) ?? myKills[0];
      segments = [
        {
          start_tick: clamp(fallback.tick - lead),
          end_tick: clamp(fallback.tick + tail),
          kill_tick: fallback.tick,
        },
      ];
      stats.usedFallback = true;
    }

    segments = segments.filter(segmentIsViable);

    if (segments.length === 0) {
      throw new Error(
        `no clip-worthy moments for ${targetSteamId} in this match — preset "${preset}" produced zero segments and the player has no kills to fall back on`,
      );
    }

    segments.sort((a, b) => a.start_tick - b.start_tick);
    const joinGap = Math.round(tickRate * 2);
    const merged: Array<{
      start_tick: number;
      end_tick: number;
      kill_tick?: number;
      pov_steam_id?: string;
    }> = [];
    for (const s of segments) {
      const last = merged[merged.length - 1];
      if (last && s.start_tick <= last.end_tick + joinGap) {
        last.end_tick = Math.max(last.end_tick, s.end_tick);
        if (s.kill_tick != null) {
          last.kill_tick = Math.max(last.kill_tick ?? s.kill_tick, s.kill_tick);
        }
      } else {
        merged.push({ ...s, pov_steam_id: targetSteamId });
      }
    }

    const MAX_SEGMENTS = 20;
    if (merged.length > MAX_SEGMENTS) {
      merged.length = MAX_SEGMENTS;
    }

    const playerLabel =
      targetName?.trim() || `Player ${targetSteamId.slice(-4)}`;
    const autoTitle = (() => {
      if (stats.usedFallback) {
        const presetLabel =
          preset === "best_round"
            ? "Best Round"
            : preset === "multikills"
              ? "Multi-Kills"
              : preset === "recap"
                ? "Match Recap"
                : "Knife Kills";
        return `${playerLabel} — Best Single Kill (no ${presetLabel.toLowerCase()} found)`;
      }
      if (preset === "knife") {
        const n = stats.knifeKills;
        return `${playerLabel} — ${n} Knife ${n === 1 ? "Kill" : "Kills"}`;
      }
      if (preset === "multikills") {
        const parts: string[] = [];
        for (const k of [5, 4, 3, 2]) {
          const n = stats.multiKillBuckets[k] ?? 0;
          if (n > 0) parts.push(`${n}× ${k}K`);
        }
        const summary = parts.length ? parts.join(", ") : "Multi-Kills";
        return `${playerLabel} — Multi-Kills (${summary})`;
      }
      if (preset === "best_round") {
        return `${playerLabel} — Best Round (${stats.bestRoundKills}K)`;
      }
      if (preset === "recap") {
        const segCount = merged.length;
        return `${playerLabel} — Match Recap (${stats.recapKills} kills · ${segCount} clip${segCount === 1 ? "" : "s"})`;
      }
      return `${playerLabel} — Highlights`;
    })();

    const chipKillsCount = myKills.filter((k) =>
      merged.some((s) => k.tick >= s.start_tick && k.tick <= s.end_tick),
    ).length;
    // Round only meaningful when the clip stays inside a single round.
    let chipRound: number | null = null;
    if ((preset === "best_round" && merged.length > 0) || merged.length === 1) {
      const firstTick = merged[0].start_tick;
      const hit = rounds.find(
        (r) => firstTick >= r.start_tick && firstTick <= r.end_tick,
      );
      chipRound = hit?.round ?? null;
    }
    const { mapName, playerName, avatarUrl } = await this.resolveChipMeta(
      matchMapId,
      targetSteamId,
    );
    const resolvedName = playerName || playerLabel;

    const result: ClipSpec = {
      match_map_id: matchMapId,
      segments: merged,
      output: { format: "mp4", resolution: output.resolution, fps: output.fps },
      destination: "library",
      title: title ?? autoTitle,
      target_name: resolvedName,
      ...(avatarUrl ? { target_avatar_url: avatarUrl } : {}),
      ...(mapName ? { map_name: mapName } : {}),
      ...(chipRound != null ? { round: chipRound } : {}),
      ...(chipKillsCount > 0 ? { kills_count: chipKillsCount } : {}),
    };
    return result;
  }

  private validateSpec(spec: ClipSpec) {
    if (!spec || typeof spec !== "object") throw new Error("spec required");
    if (!spec.match_map_id) throw new Error("spec.match_map_id required");
    if (!Array.isArray(spec.segments) || spec.segments.length === 0) {
      throw new Error("at least one segment required");
    }
    if (spec.segments.length > 20) {
      throw new Error("too many segments (max 20)");
    }
    let totalTicks = 0;
    for (const seg of spec.segments) {
      if (
        typeof seg.start_tick !== "number" ||
        typeof seg.end_tick !== "number" ||
        seg.end_tick <= seg.start_tick
      ) {
        throw new Error("each segment needs start_tick < end_tick");
      }
      totalTicks += seg.end_tick - seg.start_tick;
    }
    if (totalTicks > 64 * 60 * 15) {
      throw new Error("clip too long (max ~15 minutes of demo time)");
    }
    if (!spec.output) throw new Error("spec.output required");
    if (spec.output.format !== "mp4") {
      throw new Error("only mp4 output is supported in v1");
    }
    if (
      spec.output.resolution !== "720p" &&
      spec.output.resolution !== "1080p"
    ) {
      throw new Error("output.resolution must be 720p or 1080p");
    }
    if (spec.output.fps !== 30 && spec.output.fps !== 60) {
      throw new Error("output.fps must be 30 or 60");
    }
    if (spec.destination !== "library" && spec.destination !== "download") {
      throw new Error("destination must be library or download");
    }
  }
}
