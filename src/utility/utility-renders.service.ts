import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { PostgresService } from "../postgres/postgres.service";
import { S3Service } from "../s3/s3.service";
import { timingSafeStringEqual } from "../utilities/timingSafeStringEqual";
import { UtilityJobs } from "./enums/UtilityJobs";
import { UtilityQueues } from "./enums/UtilityQueues";
import { UtilityRenderSpec } from "./types/UtilityRenderSpec";
import { UtilityRenderStatusDto } from "./types/UtilityRenderStatusDto";

export const UTILITY_RENDER_IN_FLIGHT = [
  "queued",
  "rendering",
  "uploading",
] as const;

const STATUS_HISTORY_CAP = 50;

export type UtilityRenderRow = {
  id: string;
  utility_lineup_id: string;
  map_name: string;
  session_token: string;
  spec: UtilityRenderSpec;
  status: string;
};

export type EnqueueResult = {
  queued: boolean;
  render_id: string | null;
  status: string;
  reason: string | null;
};

type LineupSpecRow = {
  id: string;
  name: string | null;
  map_name: string;
  utility_type: string;
  side: string;
  origin_x: number;
  origin_y: number;
  origin_z: number;
  eye_z: number | null;
  view_yaw: number;
  view_pitch: number;
  flight_time_ms: number | null;
  confidence: string;
  visibility: string;
  archived_at: Date | null;
  initial_pos_x: number | null;
  initial_pos_y: number | null;
  initial_pos_z: number | null;
  initial_vel_x: number | null;
  initial_vel_y: number | null;
  initial_vel_z: number | null;
  preview_file: string | null;
  author_steam_id: string;
  public_reviewed_by: string | null;
};

@Injectable()
export class UtilityRendersService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
    @InjectQueue(UtilityQueues.UtilityRenders)
    private readonly renderQueue: Queue,
  ) {}

  // Keyed on the LINEUP, not the render job: a re-render replaces the clip in
  // place, so nothing has to go back and repoint the lineup, and the old object
  // never lingers. The clips/ prefix is the only one the Cloudflare worker's
  // route patterns match -- a utility/ prefix would 404 in the browser.
  public static GetPreviewS3Key(lineupId: string): string {
    return `clips/utility/${lineupId}.mp4`;
  }

  public static GetPreviewThumbnailS3Key(lineupId: string): string {
    return `clips/utility/${lineupId}.jpg`;
  }

  // One BullMQ job per map, because one server session films one map: the pod
  // skips any lineup whose map_name differs from the session's.
  //
  // No colon in the separator: BullMQ uses ':' to build its own redis keys and
  // rejects a custom id containing one, so `utility-render-batch:de_mirage`
  // threw "Custom Ids cannot contain :" and left the row queued with nothing
  // dispatched. Workshop maps put a numeric id in maps.name rather than a
  // slug, so the sanitiser is what keeps an unexpected name from doing it again.
  public static batchJobId(mapName: string): string {
    return `utility-render-batch-${mapName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  /**
   * The single door into the queue. Idempotent twice over: the partial unique
   * index refuses a second in-flight row for a lineup, and an already-rendered
   * lineup is left alone unless the caller explicitly asks for a re-render.
   */
  public async enqueue(
    lineupId: string,
    options: {
      requestedBySteamId?: string | null;
      force?: boolean;
    } = {},
  ): Promise<EnqueueResult> {
    const [lineup] = await this.postgres.query<Array<LineupSpecRow>>(
      `SELECT l.id::text AS id, l.name, l.map_name, l.utility_type, l.side,
              l.origin_x, l.origin_y, l.origin_z, l.eye_z,
              l.view_yaw, l.view_pitch, l.flight_time_ms, l.confidence,
              l.visibility, l.archived_at,
              l.initial_pos_x, l.initial_pos_y, l.initial_pos_z,
              l.initial_vel_x, l.initial_vel_y, l.initial_vel_z,
              l.preview_file,
              l.author_steam_id::text AS author_steam_id,
              l.public_reviewed_by::text AS public_reviewed_by
         FROM public.utility_lineups l
        WHERE l.id = $1::uuid`,
      [lineupId],
    );

    if (!lineup) {
      return this.refused("lineup not found");
    }

    if (lineup.visibility !== "Public" || lineup.archived_at !== null) {
      return this.refused(
        "only a public, unarchived lineup gets a preview render",
      );
    }

    if (lineup.preview_file && !options.force) {
      return this.refused("this lineup already has a preview");
    }

    // The requester's steam id has to be a real player: it hosts the render's
    // practice session, and host_steam_id is a foreign key.
    const requestedBy =
      options.requestedBySteamId ??
      lineup.public_reviewed_by ??
      lineup.author_steam_id;

    const spec = UtilityRendersService.buildSpec(lineup);

    // Refusing here costs nothing; refusing on the pod costs a GPU boot and a
    // practice server, and lands on the same verdict.
    const refusal = UtilityRendersService.unrenderable(lineup);

    const [row] = await this.postgres.query<
      Array<{ id: string; status: string }>
    >(
      `INSERT INTO public.utility_lineup_renders
         (utility_lineup_id, requested_by_steam_id, map_name, session_token,
          spec, status, skip_reason, error_message, last_status_at)
       VALUES ($1::uuid, $2::bigint, $3, $4, $5::jsonb, $6, $7, $7, now())
       ON CONFLICT ("utility_lineup_id")
         WHERE "status" IN ('queued', 'rendering', 'uploading')
         DO NOTHING
       RETURNING id::text AS id, status`,
      [
        lineup.id,
        requestedBy,
        lineup.map_name,
        randomBytes(32).toString("hex"),
        JSON.stringify(spec),
        refusal ? "skipped" : "queued",
        refusal,
      ],
    );

    if (!row) {
      return this.refused("a render for this lineup is already in flight");
    }

    if (refusal) {
      this.logger.log(
        `[utility-render ${row.id}] ${lineup.map_name} "${lineup.name}" cannot be filmed: ${refusal}`,
      );
      return {
        queued: false,
        render_id: row.id,
        status: row.status,
        reason: refusal,
      };
    }

    await this.dispatchMap(lineup.map_name);

    return { queued: true, render_id: row.id, status: row.status, reason: null };
  }

  /**
   * A failed or stale render, put back. Distinct from enqueue() because the
   * lineup may already carry a preview -- that is the whole reason to re-run.
   */
  public async requeue(
    lineupId: string,
    requestedBySteamId: string,
  ): Promise<EnqueueResult> {
    return this.enqueue(lineupId, {
      requestedBySteamId,
      force: true,
    });
  }

  public async cancel(renderId: string): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.utility_lineup_renders
          SET status = 'cancelled', last_status_at = now()
        WHERE id = $1::uuid
          AND status = ANY($2::text[])
      RETURNING id::text AS id`,
      [renderId, [...UTILITY_RENDER_IN_FLIGHT]],
    );
    return rows.length > 0;
  }

  public async clearFinished(): Promise<number> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `DELETE FROM public.utility_lineup_renders
        WHERE status NOT IN ('queued', 'rendering', 'uploading')
      RETURNING id::text AS id`,
    );
    return rows.length;
  }

  // ---------------------------------------------------------------------
  // Queue reads for the batch job
  // ---------------------------------------------------------------------

  public async queuedMaps(): Promise<Array<string>> {
    const rows = await this.postgres.query<Array<{ map_name: string }>>(
      `SELECT DISTINCT map_name
         FROM public.utility_lineup_renders
        WHERE status = ANY($1::text[])
          AND paused = false`,
      [[...UTILITY_RENDER_IN_FLIGHT]],
    );
    return rows.map((row) => row.map_name);
  }

  public async inFlightForMap(
    mapName: string,
  ): Promise<Array<UtilityRenderRow>> {
    return this.postgres.query<Array<UtilityRenderRow>>(
      `SELECT r.id::text AS id,
              r.utility_lineup_id::text AS utility_lineup_id,
              r.map_name, r.session_token, r.spec, r.status
         FROM public.utility_lineup_renders r
        WHERE r.map_name = $1
          AND r.status = ANY($2::text[])
          AND r.paused = false
        ORDER BY r.sort_index ASC, r.created_at ASC`,
      [mapName, [...UTILITY_RENDER_IN_FLIGHT]],
    );
  }

  // The render's practice session needs a host_steam_id, and the requester is
  // the only real player involved in a render at all.
  public async requesterFor(renderId: string): Promise<string | null> {
    const [row] = await this.postgres.query<
      Array<{ requested_by_steam_id: string | null }>
    >(
      `SELECT requested_by_steam_id::text AS requested_by_steam_id
         FROM public.utility_lineup_renders
        WHERE id = $1::uuid`,
      [renderId],
    );
    return row?.requested_by_steam_id ?? null;
  }

  public async attachSession(
    renderIds: Array<string>,
    sessionId: string,
  ): Promise<void> {
    if (renderIds.length === 0) return;
    await this.postgres.query(
      `UPDATE public.utility_lineup_renders
          SET utility_practice_session_id = $2::uuid
        WHERE id = ANY($1::uuid[])`,
      [renderIds, sessionId],
    );
  }

  public async attachJobName(
    renderIds: Array<string>,
    jobName: string,
    nodeId: string | null,
  ): Promise<void> {
    if (renderIds.length === 0) return;
    await this.postgres.query(
      `UPDATE public.utility_lineup_renders
          SET k8s_job_name = $2, game_server_node_id = $3
        WHERE id = ANY($1::uuid[])`,
      [renderIds, jobName, nodeId],
    );
  }

  public async failRenders(
    renderIds: Array<string>,
    reason: string,
  ): Promise<void> {
    if (renderIds.length === 0) return;
    await this.postgres.query(
      `UPDATE public.utility_lineup_renders
          SET status = 'error',
              error_message = $2,
              last_status_at = now(),
              game_server_node_id = NULL
        WHERE id = ANY($1::uuid[])
          AND status = ANY($3::text[])`,
      [renderIds, reason.slice(0, 500), [...UTILITY_RENDER_IN_FLIGHT]],
    );
  }

  // The lineups a render session's server is allowed to hand its client. The
  // pod is not on anybody's roster and owns none of these lineups, so the
  // player-scoped library would come back empty and `.load` would never resolve.
  public async renderLibraryLineupIds(
    matchId: string,
  ): Promise<Array<string> | null> {
    const [session] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id
         FROM public.utility_practice_sessions
        WHERE match_id = $1::uuid AND is_render = true`,
      [matchId],
    );

    if (!session) {
      return null;
    }

    const rows = await this.postgres.query<
      Array<{ utility_lineup_id: string }>
    >(
      `SELECT utility_lineup_id::text AS utility_lineup_id
         FROM public.utility_lineup_renders
        WHERE utility_practice_session_id = $1::uuid`,
      [session.id],
    );

    return rows.map((row) => row.utility_lineup_id);
  }

  // ---------------------------------------------------------------------
  // Pod callbacks
  // ---------------------------------------------------------------------

  public async validateRenderAuth(
    jobId: string,
    originAuth: unknown,
  ): Promise<{ id: string; utility_lineup_id: string } | null> {
    if (!originAuth || typeof originAuth !== "string") return null;
    const colonIndex = originAuth.indexOf(":");
    if (colonIndex === -1) return null;
    const headerJobId = originAuth.substring(0, colonIndex);
    const presentedToken = originAuth.substring(colonIndex + 1);
    if (!timingSafeStringEqual(headerJobId, jobId)) return null;

    if (!UtilityRendersService.isUuid(jobId)) return null;

    const [row] = await this.postgres.query<
      Array<{
        id: string;
        utility_lineup_id: string;
        session_token: string;
      }>
    >(
      `SELECT id::text AS id,
              utility_lineup_id::text AS utility_lineup_id,
              session_token
         FROM public.utility_lineup_renders
        WHERE id = $1::uuid`,
      [jobId],
    );

    if (!row?.session_token) return null;
    if (!timingSafeStringEqual(row.session_token, presentedToken)) return null;

    return { id: row.id, utility_lineup_id: row.utility_lineup_id };
  }

  public async getStatus(jobId: string): Promise<{ status: string } | null> {
    const [row] = await this.postgres.query<Array<{ status: string }>>(
      `SELECT status FROM public.utility_lineup_renders WHERE id = $1::uuid`,
      [jobId],
    );
    return row ? { status: row.status } : null;
  }

  public async reportStatus(
    jobId: string,
    body: UtilityRenderStatusDto,
  ): Promise<void> {
    const [current] = await this.postgres.query<
      Array<{ status: string; status_history: Array<unknown> }>
    >(
      `SELECT status, status_history
         FROM public.utility_lineup_renders
        WHERE id = $1::uuid`,
      [jobId],
    );

    if (!current) {
      this.logger.warn(
        `[utility-render ${jobId}] status post for a row that is gone`,
      );
      return;
    }

    const history = Array.isArray(current.status_history)
      ? [...current.status_history]
      : [];
    history.push({
      status: body.status,
      at: new Date().toISOString(),
      ...(body.skip_reason ? { skip_reason: body.skip_reason } : {}),
    });
    while (history.length > STATUS_HISTORY_CAP) history.shift();

    const progress =
      typeof body.progress === "number" &&
      body.progress >= 0 &&
      body.progress <= 1
        ? body.progress
        : null;

    const terminal = ["done", "error", "skipped", "cancelled"].includes(
      body.status,
    );

    await this.postgres.query(
      `UPDATE public.utility_lineup_renders
          SET status = $2,
              status_history = $3::jsonb,
              last_status_at = now(),
              progress = COALESCE($4::numeric, progress),
              error_message = COALESCE($5, error_message),
              skip_reason = COALESCE($6, skip_reason),
              duration_ms = COALESCE($7::int, duration_ms),
              game_server_node_id = CASE WHEN $8 THEN NULL ELSE game_server_node_id END
        WHERE id = $1::uuid`,
      [
        jobId,
        body.status,
        JSON.stringify(history),
        progress,
        body.error ? String(body.error).slice(0, 500) : null,
        body.skip_reason ? String(body.skip_reason).slice(0, 500) : null,
        typeof body.duration_ms === "number" && Number.isFinite(body.duration_ms)
          ? Math.round(body.duration_ms)
          : null,
        terminal,
      ],
    );
  }

  public async uploadThumbnail(
    jobId: string,
    fileStream: Readable,
  ): Promise<{ key: string }> {
    const [row] = await this.postgres.query<
      Array<{ utility_lineup_id: string; status: string }>
    >(
      `SELECT utility_lineup_id::text AS utility_lineup_id, status
         FROM public.utility_lineup_renders
        WHERE id = $1::uuid`,
      [jobId],
    );

    if (!row) throw new Error(`utility render ${jobId} not found`);
    if (["cancelled", "error", "done", "skipped"].includes(row.status)) {
      throw new Error(`render is ${row.status}`);
    }

    const key = UtilityRendersService.GetPreviewThumbnailS3Key(
      row.utility_lineup_id,
    );
    await this.s3.put(key, fileStream, "image/jpeg");

    return { key };
  }

  /**
   * The clip body, streamed straight through to S3 -- never buffered. The
   * lineup is only repointed once the object is really there, so a lineup keeps
   * its previous preview if this upload dies halfway.
   */
  public async finalizeUpload(
    jobId: string,
    fileStream: Readable,
    durationMs: number | null,
  ): Promise<{ lineupId: string; file: string }> {
    const [row] = await this.postgres.query<
      Array<{ utility_lineup_id: string; status: string }>
    >(
      `SELECT utility_lineup_id::text AS utility_lineup_id, status
         FROM public.utility_lineup_renders
        WHERE id = $1::uuid`,
      [jobId],
    );

    if (!row) throw new Error(`utility render ${jobId} not found`);
    if (["cancelled", "error", "done", "skipped"].includes(row.status)) {
      throw new Error(`render is ${row.status}`);
    }

    const key = UtilityRendersService.GetPreviewS3Key(row.utility_lineup_id);
    await this.s3.put(key, fileStream, "video/mp4");

    const thumbnailKey = UtilityRendersService.GetPreviewThumbnailS3Key(
      row.utility_lineup_id,
    );

    let thumbnail: string | null = null;
    try {
      if (await this.s3.has(thumbnailKey)) {
        thumbnail = thumbnailKey;
      }
    } catch (error) {
      this.logger.warn(
        `[utility-render ${jobId}] thumbnail check failed: ${(error as Error)?.message}`,
      );
    }

    await this.postgres.query(
      `UPDATE public.utility_lineups
          SET preview_file = $2,
              preview_thumbnail = COALESCE($3, preview_thumbnail),
              preview_duration_ms = COALESCE($4::int, preview_duration_ms),
              preview_rendered_at = now()
        WHERE id = $1::uuid`,
      [row.utility_lineup_id, key, thumbnail, durationMs],
    );

    await this.postgres.query(
      `UPDATE public.utility_lineup_renders
          SET duration_ms = COALESCE($2::int, duration_ms)
        WHERE id = $1::uuid`,
      [jobId, durationMs],
    );

    return { lineupId: row.utility_lineup_id, file: key };
  }

  // ---------------------------------------------------------------------

  public async dispatchMap(mapName: string): Promise<void> {
    // jobId is the map, so ten approvals on the same map in a row queue one
    // batch rather than ten -- BullMQ drops a duplicate id while it is live.
    await this.renderQueue.add(
      UtilityJobs.BatchUtilityRenderJob,
      { mapName },
      {
        jobId: UtilityRendersService.batchJobId(mapName),
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * A queued row is only half a booking: dispatchMap() has to have landed a
   * BullMQ job too. Anything between the INSERT and the add() -- an API restart,
   * a redis flush, or an add() that throws -- leaves a row queued with nothing
   * coming for it, and the in-flight unique index then refuses every retry, so
   * the lineup is wedged until someone cancels it by hand.
   *
   * Re-dispatching is safe to repeat: the batch jobId is the map, so BullMQ
   * drops the add outright while a job for that map is still live or delayed.
   */
  public async reconcileQueued(): Promise<number> {
    const rows = await this.postgres.query<Array<{ map_name: string }>>(
      `SELECT DISTINCT map_name
         FROM public.utility_lineup_renders
        WHERE status = 'queued'`,
    );

    for (const row of rows) {
      try {
        await this.dispatchMap(row.map_name);
      } catch (error) {
        this.logger.warn(
          `[utility-render] could not re-dispatch ${row.map_name}: ${(error as Error)?.message}`,
        );
      }
    }

    if (rows.length > 0) {
      this.logger.log(
        `[utility-render] reconciled ${rows.length} queued map(s): ` +
          rows.map((row) => row.map_name).join(", "),
      );
    }

    return rows.length;
  }

  public static buildSpec(lineup: LineupSpecRow): UtilityRenderSpec {
    return {
      lineup_id: lineup.id,
      lineup_name: lineup.name ?? "",
      map_name: lineup.map_name,
      nade_type: lineup.utility_type,
      side: lineup.side,
      origin_x: Number(lineup.origin_x),
      origin_y: Number(lineup.origin_y),
      origin_z: Number(lineup.origin_z),
      eye_z: lineup.eye_z === null ? null : Number(lineup.eye_z),
      view_yaw: Number(lineup.view_yaw),
      view_pitch: Number(lineup.view_pitch),
      flight_time_ms:
        lineup.flight_time_ms === null ? null : Number(lineup.flight_time_ms),
      confidence: lineup.confidence,
      has_seed: UtilityRendersService.hasSeed(lineup),
      initial_pos_x: UtilityRendersService.num(lineup.initial_pos_x),
      initial_pos_y: UtilityRendersService.num(lineup.initial_pos_y),
      initial_pos_z: UtilityRendersService.num(lineup.initial_pos_z),
      initial_vel_x: UtilityRendersService.num(lineup.initial_vel_x),
      initial_vel_y: UtilityRendersService.num(lineup.initial_vel_y),
      initial_vel_z: UtilityRendersService.num(lineup.initial_vel_z),
      output: { resolution: "1080p", fps: 60 },
    };
  }

  // The pod's own refusals, applied before a GPU is booked. Kept in the same
  // words the pod uses so a reviewer sees one vocabulary either way.
  public static unrenderable(lineup: LineupSpecRow): string | null {
    if (!lineup.name || lineup.name.trim().length === 0) {
      return "lineup has no name; the practice plugin resolves lineups by name only";
    }
    if (!UtilityRendersService.hasSeed(lineup)) {
      return "lineup has no recorded physics seed (initial position/velocity) — the throw cannot be reproduced exactly";
    }
    if (lineup.confidence !== "exact") {
      return `lineup confidence is '${lineup.confidence}', not 'exact' — the plugin refuses to replay it`;
    }
    return null;
  }

  private static hasSeed(lineup: LineupSpecRow): boolean {
    const values = [
      lineup.initial_pos_x,
      lineup.initial_pos_y,
      lineup.initial_pos_z,
      lineup.initial_vel_x,
      lineup.initial_vel_y,
      lineup.initial_vel_z,
    ].map((value) => UtilityRendersService.num(value));

    if (values.some((value) => value === null)) {
      return false;
    }

    return Math.hypot(values[3], values[4], values[5]) > 0;
  }

  private static num(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private static isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private refused(reason: string): EnqueueResult {
    return { queued: false, render_id: null, status: "refused", reason };
  }
}
