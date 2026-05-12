import { Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { e_player_roles_enum } from "generated/schema";
import { HasuraService } from "../../hasura/hasura.service";
import { S3Service } from "../../s3/s3.service";
import { GameStreamerService } from "../game-streamer/game-streamer.service";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { ClipSpec } from "./types/ClipSpec";
import { ClipRenderStatusDto } from "./types/ClipRenderStatusDto";
import {
  BATCH_HIGHLIGHTS_JOB_NAME,
  IN_FLIGHT_STATUSES,
  resolveInClusterApiBase,
} from "./clips.constants";

const STATUS_HISTORY_CAP = 50;

@Injectable()
export class ClipsService {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly s3: S3Service,
    private readonly gameStreamer: GameStreamerService,
    @InjectQueue(MatchQueues.Clips)
    private readonly batchQueue: Queue,
  ) {}

  public static GetClipS3Key(userSteamId: string, jobId: string) {
    return `clips/${userSteamId}/${jobId}.mp4`;
  }
  public static GetClipThumbnailS3Key(userSteamId: string, jobId: string) {
    return `clips/${userSteamId}/${jobId}.jpg`;
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
    const renderSpeed = this.resolveRenderSpeed();
    const totalTicks = spec.segments.reduce(
      (acc, s) => acc + (s.end_tick - s.start_tick),
      0,
    );

    this.logger.log(
      `[clip ${jobId}] dispatching to pod=${session.id} ` +
        `speed=${renderSpeed}x ` +
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
          pov_steam_id: s.pov_steam_id,
        })),
        output_dims: dims,
        output_fps: spec.output.fps,
        render_speed: renderSpeed,
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

  private resolveRenderSpeed(): number {
    const raw = process.env.CLIP_RENDER_SPEED;
    if (!raw) return 1;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    if (parsed > 4) {
      this.logger.warn(
        `[clips] CLIP_RENDER_SPEED='${raw}' clamped to 4 (anything higher destabilises cs2)`,
      );
      return 4;
    }
    return parsed;
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
      visibility?: "private" | "unlisted" | "match" | "public";
      target_steam_id?: string | null;
    },
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
    if (String(row.user_steam_id) !== String(userSteamId)) {
      throw new Error("you can only edit your own clips");
    }

    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const trimmed = patch.title?.trim() ?? null;
      set.title = trimmed && trimmed.length > 0 ? trimmed : null;
    }
    if (patch.visibility !== undefined) {
      const allowed = ["private", "unlisted", "match", "public"];
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

    const fileKey = row.file ?? ClipsService.GetClipS3Key(userSteamId, clipId);
    await this.hasura.mutation({
      delete_match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
      },
    });

    try {
      await this.s3.remove(fileKey);
      await this.s3.remove(
        ClipsService.GetClipThumbnailS3Key(userSteamId, clipId),
      );
    } catch (error) {
      this.logger.warn(
        `[clip ${clipId}] s3 remove failed (row already deleted, leaving orphaned object ${fileKey}): ${(error as Error)?.message}`,
      );
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
        last && last.status === "booting" ? (last as { boot_stage?: string }).boot_stage : undefined;
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
    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: { pk_columns: { id: jobId }, _set: set },
        id: true,
      },
    });
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
      const kills =
        (demo?.kills as Array<{
          tick: number;
          killer?: string;
          victim?: string;
        }>) ?? [];
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
      if (!(await this.hasGpuNode())) {
        this.logger.log(
          `[auto-clips] demo ${matchMapDemoId} skipped: no GPU node registered`,
        );
        return 0;
      }
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

    const kills = (demo.kills as Array<{ killer?: string }> | undefined) ?? [];
    if (kills.length === 0) return 0;

    const killers = new Set<string>();
    for (const k of kills) if (k.killer) killers.add(k.killer);

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

    const insertObjects = pendingObjects.map((p) => ({
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
      if (!(await this.hasGpuNode())) {
        this.logger.log(
          `[auto-clips] match ${matchId} skipped: no GPU node registered`,
        );
        return 0;
      }
    }

    const defaultVisibility = await this.readSetting(
      "auto_clip_default_visibility",
      "public",
    );

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
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

    const allKillers = new Set<string>();
    for (const demos of parsedDemosByMap.values()) {
      for (const demo of demos) {
        const kills =
          (demo?.kills as Array<{ killer?: string }> | undefined) ?? [];
        for (const k of kills) if (k.killer) allKillers.add(k.killer);
      }
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
        const kills =
          (demo?.kills as Array<{ killer?: string }> | undefined) ?? [];
        if (kills.length === 0) continue;

        const killers = new Set<string>();
        for (const k of kills) if (k.killer) killers.add(k.killer);

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
      const insertObjects = pendingObjects.map((p) => ({
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
      }));
      try {
        const { insert_clip_render_jobs } = await this.hasura.mutation({
          insert_clip_render_jobs: {
            __args: { objects: insertObjects },
            returning: {
              id: true,
              match_map_id: true,
              match_map_demo_id: true,
            },
          },
        });
        const returning =
          (insert_clip_render_jobs?.returning as
            | Array<{
                id: string;
                match_map_id: string;
                match_map_demo_id: string;
              }>
            | undefined) ?? [];
        for (let i = 0; i < returning.length; i++) {
          const inserted = returning[i];
          const pending = pendingObjects[i];
          if (!inserted?.id || !pending) continue;
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

  /**
   * Returns true when at least one GPU node is registered (regardless of
   * online/offline status). Auto-generated highlights require a GPU node to
   * exist — otherwise jobs would queue forever with nowhere to render.
   */
  private async hasGpuNode(): Promise<boolean> {
    const { game_server_nodes_aggregate } = await this.hasura.query({
      game_server_nodes_aggregate: {
        __args: { where: { gpu: { _eq: true } } },
        aggregate: { count: true },
      },
    });
    return (game_server_nodes_aggregate?.aggregate?.count ?? 0) > 0;
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
    const kills =
      (demo.kills as Array<{
        tick: number;
        killer?: string;
        victim?: string;
        weapon?: string;
        headshot?: boolean;
      }>) ?? [];
    const rounds =
      (demo.round_ticks as Array<{
        round: number;
        start_tick: number;
        end_tick: number;
      }>) ?? [];

    const myKills = kills.filter((k) => k.killer === targetSteamId);
    const lead = Math.round(tickRate * 5);
    const tail = Math.round(tickRate * 3);
    const CLUSTER_GAP_SECS = 10;
    const clusterGapTicks = Math.round(tickRate * CLUSTER_GAP_SECS);
    const clamp = (t: number) => Math.max(0, Math.min(t, totalTicks || t));

    const clusterKills = (
      ks: Array<{ tick: number }>,
    ): Array<{ start_tick: number; end_tick: number }> => {
      if (ks.length === 0) return [];
      const sorted = [...ks].sort((a, b) => a.tick - b.tick);
      const out: Array<{ start_tick: number; end_tick: number }> = [];
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
        });
        clusterStart = sorted[i].tick;
        clusterEnd = sorted[i].tick;
      }
      out.push({
        start_tick: clamp(clusterStart - lead),
        end_tick: clamp(clusterEnd + tail),
      });
      return out;
    };

    let segments: Array<{ start_tick: number; end_tick: number }> = [];
    const stats = {
      knifeKills: 0,
      multiKillBuckets: { 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>,
      bestRoundKills: 0,
      recapKills: 0,
      usedFallback: false,
    };

    if (preset === "knife") {
      const knife = myKills.filter((k) =>
        (k.weapon ?? "").toLowerCase().includes("knife"),
      );
      stats.knifeKills = knife.length;
      segments = knife.map((k) => ({
        start_tick: clamp(k.tick - lead),
        end_tick: clamp(k.tick + tail),
      }));
    } else if (preset === "multikills") {
      for (const r of rounds) {
        const inRound = myKills.filter(
          (k) => k.tick >= r.start_tick && k.tick <= r.end_tick,
        );
        if (inRound.length < 2) continue;
        const bucket = Math.min(5, inRound.length);
        stats.multiKillBuckets[bucket] =
          (stats.multiKillBuckets[bucket] ?? 0) + 1;
        segments.push(...clusterKills(inRound));
      }
    } else if (preset === "best_round") {
      let best: {
        round: number;
        count: number;
        span: number;
        start: number;
        end: number;
      } | null = null;
      for (const r of rounds) {
        const inRound = myKills
          .filter((k) => k.tick >= r.start_tick && k.tick <= r.end_tick)
          .sort((a, b) => a.tick - b.tick);
        const count = inRound.length;
        if (count === 0) continue;
        const span = count >= 2 ? inRound[count - 1].tick - inRound[0].tick : 0;
        if (
          !best ||
          count > best.count ||
          (count === best.count && span < best.span)
        ) {
          best = {
            round: r.round,
            count,
            span,
            start: r.start_tick,
            end: r.end_tick,
          };
        }
      }
      if (best && best.count > 0) {
        stats.bestRoundKills = best.count;
        const inRound = myKills
          .filter((k) => k.tick >= best!.start && k.tick <= best!.end)
          .sort((a, b) => a.tick - b.tick);
        segments = clusterKills(inRound);
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
        },
      ];
      stats.usedFallback = true;
    }

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
      pov_steam_id?: string;
    }> = [];
    for (const s of segments) {
      const last = merged[merged.length - 1];
      if (last && s.start_tick <= last.end_tick + joinGap) {
        last.end_tick = Math.max(last.end_tick, s.end_tick);
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

    const result: ClipSpec = {
      match_map_id: matchMapId,
      segments: merged,
      output: { format: "mp4", resolution: output.resolution, fps: output.fps },
      destination: "library",
      title: title ?? autoTitle,
      target_name: playerLabel,
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
