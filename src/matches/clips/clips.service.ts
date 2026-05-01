import { Injectable, Logger } from "@nestjs/common";
import {
  BatchV1Api,
  KubeConfig,
  V1EnvVar,
} from "@kubernetes/client-node";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { HasuraService } from "../../hasura/hasura.service";
import { S3Service } from "../../s3/s3.service";
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import { GameStreamerService } from "../game-streamer/game-streamer.service";
import { DemoMetadataService } from "../../demos/demo-metadata.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { ClipSpec } from "./types/ClipSpec";
import { ClipRenderStatusDto } from "./types/ClipRenderStatusDto";

const STATUS_HISTORY_CAP = 50;

// In-flight statuses for the unique partial index in the migration —
// keep in sync with the index `where` clause.
const IN_FLIGHT_STATUSES = ["queued", "rendering", "uploading"] as const;

@Injectable()
export class ClipsService {
  private readonly namespace: string;
  private readonly gameServerConfig: GameServersConfig;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly s3: S3Service,
    private readonly gameStreamer: GameStreamerService,
    private readonly demoMetadata: DemoMetadataService,
  ) {
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.namespace = this.gameServerConfig.namespace;
  }

  public static GetClipRenderJobName(jobId: string) {
    // K8s names are 63 chars max + need to start with [a-z0-9]; same
    // truncation pattern as GetDemoJobIdForSession.
    return `gs-clip-${jobId.replace(/-/g, "").slice(0, 12)}`;
  }

  // S3 key layout: clips/{user}/{job}.mp4. Same bucket as demos so the
  // backblaze-proxy worker (cloudflare-workers/backblaze-proxy) can
  // serve them without new credentials.
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

    // Demo must exist + be parsed so tick math is meaningful.
    const demo = await this.demoMetadata.getDemoForMap(spec.match_map_id);
    if (!demo) {
      throw new Error(`no uploaded demo for match_map ${spec.match_map_id}`);
    }
    if (!demo.metadata_parsed_at || !demo.total_ticks) {
      throw new Error("demo metadata not ready — try again in a moment");
    }
    for (const seg of spec.segments) {
      if (seg.start_tick < 0 || seg.end_tick > demo.total_ticks) {
        throw new Error(
          `segment ticks out of range (0..${demo.total_ticks}): ${seg.start_tick}..${seg.end_tick}`,
        );
      }
    }

    // Per-user concurrency: the unique partial index would catch this
    // too, but a friendly error beats a constraint violation 500.
    const inflight = await this.findInFlightForUser(userSteamId);
    if (inflight) {
      throw new Error(
        "you already have a clip render in progress — wait for it to finish or cancel it",
      );
    }

    const sessionToken = randomBytes(24).toString("hex");

    // Insert with a placeholder k8s_job_name; we update it once the row
    // gets its uuid back so the name can be derived from the id.
    const { insert_clip_render_jobs_one } = await this.hasura.mutation({
      insert_clip_render_jobs_one: {
        __args: {
          object: {
            user_steam_id: userSteamId,
            match_map_id: spec.match_map_id,
            session_token: sessionToken,
            k8s_job_name: "pending",
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

    const k8sJobName = ClipsService.GetClipRenderJobName(jobId);
    await this.hasura.mutation({
      update_clip_render_jobs_by_pk: {
        __args: {
          pk_columns: { id: jobId },
          _set: { k8s_job_name: k8sJobName },
        },
        id: true,
      },
    });

    // Demo file presigned URL — same flow as watchDemo. Long expiry
    // (2h) so a queued render that waits behind another render still
    // has a valid url when its turn comes.
    const presignedDemoUrl = await this.s3.getPresignedUrl(
      demo.file,
      undefined,
      60 * 60 * 2,
      "get",
    );

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: demo.match_id },
        id: true,
        region: true,
      },
    });
    if (!match) {
      throw new Error(`match ${demo.match_id} not found`);
    }

    const nodeId = await this.gameStreamer.pickGpuNode(match.region);
    await this.gameStreamer.deleteJob(k8sJobName);

    const env: V1EnvVar[] = [
      { name: "MATCH_MAP_ID", value: spec.match_map_id },
      { name: "DEMO_URL", value: presignedDemoUrl },
      { name: "DEMO_FILE_NAME", value: demo.file },
      { name: "CLIP_RENDER_JOB_ID", value: jobId },
      { name: "CLIP_RENDER_TOKEN", value: sessionToken },
      { name: "CLIP_SPEC", value: JSON.stringify(spec) },
    ];
    if (demo.tick_rate != null) {
      env.push({ name: "DEMO_TICK_RATE", value: String(demo.tick_rate) });
    }
    if (demo.total_ticks != null) {
      env.push({ name: "DEMO_TOTAL_TICKS", value: String(demo.total_ticks) });
    }
    if (demo.workshop_id) {
      env.push({ name: "WORKSHOP_ID", value: demo.workshop_id });
    }
    if (demo.cs2_build) {
      env.push({ name: "CS2_BUILD", value: demo.cs2_build });
    }
    // Output framing — the pod consumes these to size the GStreamer
    // pipeline. Pinned to the ones the editor exposes; defended by
    // validateSpec.
    const dims = spec.output.resolution === "720p" ? "1280x720" : "1920x1080";
    env.push({ name: "CLIP_OUTPUT_DIMS", value: dims });
    env.push({ name: "CLIP_OUTPUT_FPS", value: String(spec.output.fps) });

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    this.logger.log(
      `[clip ${jobId}] starting on node ${nodeId} (job=${k8sJobName})`,
    );

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.gameStreamer.buildJobSpec(
        k8sJobName,
        demo.match_id,
        "render-clip",
        nodeId,
        env,
        { "clip-render-job-id": jobId },
      ),
    });

    return { jobId };
  }

  public async cancelClipRender(userSteamId: string, jobId: string) {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
        user_steam_id: true,
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
    if (row.status === "done" || row.status === "error" || row.status === "cancelled") {
      // No-op: terminal state.
      return;
    }

    try {
      await this.gameStreamer.deleteJob(row.k8s_job_name);
    } catch (error) {
      this.logger.error(
        `[clip ${jobId}] cancel deleteJob failed: ${(error as Error)?.message}`,
      );
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
  }

  public async deleteClip(userSteamId: string, clipId: string) {
    const { match_clips_by_pk: row } = await this.hasura.query({
      match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
        user_steam_id: true,
        s3_url: true,
      },
    });
    if (!row) {
      throw new Error(`clip ${clipId} not found`);
    }
    if (String(row.user_steam_id) !== String(userSteamId)) {
      throw new Error("you can only delete your own clips");
    }

    // Best-effort S3 cleanup — if the bucket's gone we still want to
    // clear the row so the user's library stops showing a dead clip.
    try {
      await this.s3.remove(
        ClipsService.GetClipS3Key(userSteamId, clipId),
      );
      await this.s3.remove(
        ClipsService.GetClipThumbnailS3Key(userSteamId, clipId),
      );
    } catch (error) {
      this.logger.warn(
        `[clip ${clipId}] s3 remove failed: ${(error as Error)?.message}`,
      );
    }

    await this.hasura.mutation({
      delete_match_clips_by_pk: {
        __args: { id: clipId },
        id: true,
      },
    });
  }

  public async validateClipRenderAuth(
    jobId: string,
    originAuth: unknown,
  ): Promise<{ id: string; user_steam_id: string; match_map_id: string } | null> {
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

  public async reportClipRenderStatus(
    jobId: string,
    body: ClipRenderStatusDto,
  ) {
    const { clip_render_jobs_by_pk: current } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        status_history: true,
      },
    });
    if (!current) {
      this.logger.warn(
        `[clip ${jobId}] reportStatus: row missing — was the job cancelled?`,
      );
      return;
    }

    // status_history is jsonb — codegen types it as unknown, so we
    // narrow at the consumption site rather than at the DB boundary.
    const prevHistory = current.status_history as
      | Array<{ status: string; at: string }>
      | null
      | undefined;
    const nextHistory = Array.isArray(prevHistory) ? [...prevHistory] : [];
    nextHistory.push({ status: body.status, at: new Date().toISOString() });
    while (nextHistory.length > STATUS_HISTORY_CAP) nextHistory.shift();

    const set: Record<string, unknown> = {
      status: body.status,
      status_history: nextHistory,
      last_status_at: "now()",
    };
    if (typeof body.progress === "number" && body.progress >= 0 && body.progress <= 1) {
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

  // Pod calls this once it has the rendered mp4 on disk — controller
  // streams the multipart file straight into S3 then we promote the
  // job row to `done` and create the match_clips row.
  public async finalizeClipUpload(
    jobId: string,
    fileStream: Readable,
    durationMs: number | null,
  ): Promise<{ clipId: string; s3Url: string }> {
    const { clip_render_jobs_by_pk: row } = await this.hasura.query({
      clip_render_jobs_by_pk: {
        __args: { id: jobId },
        id: true,
        user_steam_id: true,
        match_map_id: true,
        spec: true,
        status: true,
      },
    });
    if (!row) throw new Error(`clip render ${jobId} not found`);
    if (row.status === "cancelled") {
      throw new Error("render was cancelled");
    }

    const userSteamId = String(row.user_steam_id);
    const key = ClipsService.GetClipS3Key(userSteamId, jobId);

    await this.s3.put(key, fileStream);

    // spec is jsonb — codegen types it as unknown. The api validated
    // the shape on insert (validateSpec) so casting at the read site
    // is safe.
    const spec = row.spec as unknown as ClipSpec;
    const title = spec?.title ?? null;
    const s3Url = `https://${process.env.DEMOS_DOMAIN}/${key}`;

    // Only create a library row when the spec asked for it. Download-
    // only renders still get the file in S3 (the pod uploads the same
    // way) but we reap the object on the Cloudflare worker after a
    // short ttl — phase 2 wires that. For v1, both destinations create
    // a row; the web hides download-only entries from the library.
    const { insert_match_clips_one } = await this.hasura.mutation({
      insert_match_clips_one: {
        __args: {
          object: {
            user_steam_id: userSteamId,
            match_map_id: row.match_map_id,
            title,
            duration_ms: durationMs,
            s3_url: s3Url,
            visibility: "private",
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

    return { clipId, s3Url };
  }

  private async findInFlightForUser(userSteamId: string) {
    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            user_steam_id: { _eq: userSteamId },
            status: { _in: [...IN_FLIGHT_STATUSES] },
          },
          limit: 1,
        },
        id: true,
        status: true,
      },
    });
    return clip_render_jobs?.[0] ?? null;
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
    // Cap clip length: a 10-min clip at 64 tps is 38400 ticks. Keep
    // headroom but stop pathological inputs from booking a pod for
    // hours of wallclock render time.
    if (totalTicks > 64 * 60 * 15) {
      throw new Error("clip too long (max ~15 minutes of demo time)");
    }
    if (!spec.output) throw new Error("spec.output required");
    if (spec.output.format !== "mp4") {
      throw new Error("only mp4 output is supported in v1");
    }
    if (spec.output.resolution !== "720p" && spec.output.resolution !== "1080p") {
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
