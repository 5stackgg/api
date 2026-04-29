import { Injectable, Logger } from "@nestjs/common";
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  V1Job,
  V1EnvVar,
  V1Service,
} from "@kubernetes/client-node";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../../hasura/hasura.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";
import { e_game_server_node_statuses_enum } from "../../../generated";
import { AppConfig } from "../../configs/types/AppConfig";
import { randomBytes } from "node:crypto";

type StreamerMode = "live" | "create-clips" | "demo";

export type DemoControlAction =
  | "pause"
  | "resume"
  | "toggle"
  | "seek"
  | "skip"
  | "speed"
  | "round"
  | "state";

// Source of truth for which demo-control actions are allowed. Used by
// both the WS gateway and the service layer so a future caller can't
// bypass it by skipping the gateway.
export const DEMO_CONTROL_ACTIONS: ReadonlySet<DemoControlAction> = new Set<
  DemoControlAction
>(["pause", "resume", "toggle", "seek", "skip", "speed", "round", "state"]);

// Cap status_history at this many entries. Demos churn through ~10
// stages on a cold boot; 50 covers reasonable retries without letting
// a stuck pod balloon the jsonb column.
const STATUS_HISTORY_CAP = 50;

const GAME_STREAMER_TITLE = "5Stack Game Streamer";

@Injectable()
export class GameStreamerService {
  private readonly namespace: string;
  private readonly gameServerConfig: GameServersConfig;
  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
  ) {
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.appConfig = this.config.get<AppConfig>("app");
    this.namespace = this.gameServerConfig.namespace;
  }

  public static GetLiveJobId(matchId: string) {
    return `gs-live-${matchId}`;
  }

  public static GetLiveServiceName(matchId: string) {
    return `gs-live-${matchId}`;
  }

  private getSpecServerUrl(matchId: string, action: string) {
    const svc = GameStreamerService.GetLiveServiceName(matchId);
    return `http://${svc}.${this.namespace}.svc.cluster.local:1350/spec/${action}`;
  }

  private async callSpec(
    matchId: string,
    action: "click" | "jump" | "player" | "slot" | "autodirector",
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    const url = this.getSpecServerUrl(matchId, action);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      const cause = (error as Error)?.cause as
        | { code?: string; message?: string }
        | undefined;
      const code = cause?.code ?? (error as { code?: string })?.code;
      const message = (error as Error)?.message ?? String(error);

      this.logger.error(
        `[${matchId}] spec ${action} transport error: code=${code ?? "<none>"} message=${message} url=${url}`,
      );

      if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        throw new Error(
          `no live stream is running for this match (spec-server DNS not found)`,
        );
      }
      if (code === "ECONNREFUSED") {
        throw new Error(
          `streamer pod is up but spec-server is not listening yet — try again in a few seconds`,
        );
      }
      if (
        (error as Error)?.name === "TimeoutError" ||
        code === "UND_ERR_CONNECT_TIMEOUT"
      ) {
        throw new Error(
          `spec-server timed out — the streamer pod is unhealthy`,
        );
      }
      throw new Error(`spec-server ${action} unreachable: ${message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(
        `[${matchId}] spec ${action} -> ${res.status}: ${text.slice(0, 500)}`,
      );
      throw new Error(
        `spec-server ${action} -> ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return res.json().catch(() => ({ ok: true }));
  }

  public async specClick(matchId: string, button: "left" | "right") {
    return this.callSpec(matchId, "click", { button });
  }

  public async specJump(matchId: string) {
    return this.callSpec(matchId, "jump");
  }

  public async specPlayer(matchId: string, accountid: number) {
    return this.callSpec(matchId, "player", { accountid });
  }

  public async specSlot(matchId: string, slot: number) {
    return this.callSpec(matchId, "slot", { slot });
  }

  public async specAutodirector(matchId: string, enabled: boolean) {
    const result = await this.callSpec(matchId, "autodirector", { enabled });
    await this.hasura.mutation({
      update_match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
          // Generated Hasura types lag this migration until codegen runs.
          _set: { autodirector: enabled } as any,
        },
        affected_rows: true,
      },
    });
    return result;
  }

  public static GetClipsJobId(matchId: string) {
    return `gs-clips-${matchId}`;
  }

  // K8s names derive from the demo session id (DB-issued uuid). Using
  // the row's uuid as the source of truth keeps cluster state and the
  // session row in lockstep — to find the pod for a session, take its
  // first 12 hex chars and prefix with `gs-demo-`. K8s names cap at 63
  // chars; 12 chars of uuid keeps us well clear with room to extend.
  public static GetDemoJobIdForSession(sessionId: string) {
    return `gs-demo-${sessionId.replace(/-/g, "").slice(0, 12)}`;
  }
  public static GetDemoServiceNameForSession(sessionId: string) {
    return GameStreamerService.GetDemoJobIdForSession(sessionId);
  }

  private getDemoSpecUrl(sessionId: string, action: string) {
    const svc = GameStreamerService.GetDemoServiceNameForSession(sessionId);
    return `http://${svc}.${this.namespace}.svc.cluster.local:1350/demo/${action}`;
  }

  /**
   * Spawn a per-user demo-playback pod. Inserts a `match_demo_sessions`
   * row first so the web client can subscribe to it for status updates
   * (no API polling). Returns the session row id + stream URL; the
   * pod's status-reporter daemon will populate `status` / `is_live`
   * / `error_message` over the lifetime of the session.
   *
   * Pre-signs the demo S3 URL at job-spawn time so the streamer pod
   * doesn't need its own S3 credentials. The 60-min expiry covers
   * typical demo viewing windows.
   */
  public async startDemoPlayback(
    matchMapId: string,
    userSteamId: string,
    options: {
      demoFile: string;
      presignedDemoUrl: string;
      roundTicks: unknown;
      totalTicks: number | null;
      tickRate: number | null;
      // workshop_id from the demo header (parsed by demo-parser).
      // When set, the streamer pod runs `steamcmd +workshop_download_item
      // 730 <id>` before launching CS2 — without it CS2 stalls on a
      // Subscribe? prompt the moment +playdemo touches the map.
      workshopId: string | null;
      cs2Build: string | null;
    },
  ): Promise<{
    streamUrl: string;
    sessionId: string;
    matchId: string;
  }> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: { match_map_id: { _eq: matchMapId } },
          limit: 1,
        },
        match_id: true,
      },
    });
    const matchId = match_map_demos[0]?.match_id;
    if (!matchId) {
      throw new Error(`no demo for match_map ${matchMapId}`);
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        region: true,
      },
    });
    if (!match) {
      throw new Error(`match ${matchId} not found`);
    }

    // Tear down any existing session this user has for this map. Unique
    // index (match_map_id, watcher_steam_id) would otherwise reject
    // the insert below; on the cluster side we delete the prior pod so
    // we don't leak GPU sessions across reconnects.
    const existing = await this.findDemoSession(matchMapId, userSteamId);
    if (existing) {
      this.logger.log(
        `[demo] tearing down stale session ${existing.id} for ${userSteamId} on ${matchMapId} before new start`,
      );
      await this.stopDemoSessionById(existing.id, existing.k8s_job_name);
    }

    // Issue session credentials before the K8s spawn so the pod can
    // report status from boot. Token is opaque to the client — it
    // never leaves the pod env / status-reporter auth header.
    const sessionToken = randomBytes(24).toString("hex");

    const streamUrl = `${this.appConfig.gameStreamHlsBase}/${matchId}/`;

    // Generated Zeus types lag the match_demo_sessions migration until
    // codegen runs; cast the whole graph until the types catch up.
    // Seed status_history with `booting` so the stepper marks
    // "Allocating GPU pod" as ✓ from the moment the row appears.
    // The streamer pod's first push is `preparing` — without this
    // seed, `booting` would never enter history and the stepper
    // would falsely render it as skipped.
    const bootIso = new Date().toISOString();
    const insertRes = await this.hasura.mutation({
      insert_match_demo_sessions_one: {
        __args: {
          object: {
            match_id: matchId,
            match_map_id: matchMapId,
            watcher_steam_id: userSteamId,
            // k8s_job_name + session_token populated below once we know
            // the row id (k8s name derives from it). Two-phase insert
            // keeps the row id as the source of truth for naming.
            k8s_job_name: "pending",
            session_token: sessionToken,
            stream_url: streamUrl,
            status: "booting",
            status_history: [{ status: "booting", at: bootIso }],
          },
        },
        id: true,
      },
    } as any);
    const sessionId = (insertRes as any)?.insert_match_demo_sessions_one?.id;
    if (!sessionId) {
      throw new Error("failed to insert demo session row");
    }

    const jobName = GameStreamerService.GetDemoJobIdForSession(sessionId);

    await this.hasura.mutation({
      update_match_demo_sessions_by_pk: {
        __args: {
          pk_columns: { id: sessionId },
          _set: { k8s_job_name: jobName },
        },
        id: true,
      },
    } as any);

    const nodeId = await this.pickGpuNode(match.region);

    await this.deleteJob(jobName);

    const env: V1EnvVar[] = [
      { name: "MATCH_MAP_ID", value: matchMapId },
      { name: "DEMO_URL", value: options.presignedDemoUrl },
      { name: "DEMO_FILE_NAME", value: options.demoFile },
      { name: "DEMO_SESSION_ID", value: sessionId },
      { name: "DEMO_SESSION_TOKEN", value: sessionToken },
    ];
    if (options.roundTicks != null) {
      env.push({ name: "ROUND_TICKS", value: JSON.stringify(options.roundTicks) });
    }
    if (options.totalTicks != null) {
      env.push({ name: "DEMO_TOTAL_TICKS", value: String(options.totalTicks) });
    }
    if (options.tickRate != null) {
      env.push({ name: "DEMO_TICK_RATE", value: String(options.tickRate) });
    }
    if (options.workshopId) {
      env.push({ name: "WORKSHOP_ID", value: options.workshopId });
    }
    if (options.cs2Build) {
      env.push({ name: "CS2_BUILD", value: options.cs2Build });
    }

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    this.logger.log(
      `[demo ${sessionId}] starting on node ${nodeId} (job=${jobName})`,
    );

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJobSpec(jobName, matchId, "demo", nodeId, env, {
        "session-id": sessionId,
      }),
    });

    await this.createDemoService(sessionId);

    return {
      streamUrl,
      sessionId,
      matchId,
    };
  }

  /**
   * Stop the calling user's demo session for a match map. Looks up the
   * row first so we know the k8s job name to tear down — the row is
   * authoritative for cluster naming, in case GetDemoJobIdForSession
   * ever changes.
   */
  public async stopDemoPlayback(matchMapId: string, userSteamId: string) {
    const session = await this.findDemoSession(matchMapId, userSteamId);
    if (!session) {
      this.logger.log(
        `[demo] stop: no active session for ${userSteamId} on ${matchMapId}`,
      );
      return;
    }
    await this.stopDemoSessionById(session.id, session.k8s_job_name);
  }

  /**
   * Tear down by session id. Used by stopDemoPlayback (user-initiated)
   * AND by the idle reaper. Deletes the K8s job + service + DB row.
   * Errors during k8s teardown are logged but the row is still removed
   * — the row is what the web subscribes to, and a dangling pod will
   * be cleaned up by the next reaper sweep.
   */
  public async stopDemoSessionById(sessionId: string, k8sJobName: string) {
    this.logger.log(`[demo ${sessionId}] stopping (job=${k8sJobName})`);

    try {
      await this.deleteJob(k8sJobName);
    } catch (error) {
      this.logger.error(
        `[demo ${sessionId}] deleteJob failed: ${(error as Error)?.message}`,
      );
    }

    try {
      await this.deleteDemoService(sessionId);
    } catch (error) {
      this.logger.error(
        `[demo ${sessionId}] deleteService failed: ${(error as Error)?.message}`,
      );
    }

    await this.hasura.mutation({
      delete_match_demo_sessions_by_pk: {
        __args: { id: sessionId },
        id: true,
      },
    } as any);
  }

  public async demoControl(
    matchMapId: string,
    userSteamId: string,
    action: DemoControlAction,
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    // Defense in depth: the WS gateway also filters, but the service
    // is publicly callable from any injected caller. Validate here so
    // a future caller can't smuggle an arbitrary path component into
    // getDemoSpecUrl via `action`.
    if (!DEMO_CONTROL_ACTIONS.has(action)) {
      throw new Error(`unsupported demo control action: ${action}`);
    }

    const session = await this.findDemoSession(matchMapId, userSteamId);
    if (!session) {
      throw new Error(
        "no demo playback session is running — call watchDemo first",
      );
    }

    // Bump activity *before* the network call so the reaper doesn't
    // race a slow spec-server response and prematurely kill the pod
    // mid-control-acknowledgement.
    await this.bumpDemoSessionActivity(session.id);

    const url = this.getDemoSpecUrl(session.id, action);
    const method = action === "state" ? "GET" : "POST";

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers:
          method === "POST" ? { "Content-Type": "application/json" } : {},
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      const cause = (error as Error)?.cause as
        | { code?: string; message?: string }
        | undefined;
      const code = cause?.code ?? (error as { code?: string })?.code;
      const message = (error as Error)?.message ?? String(error);
      this.logger.error(
        `[demo ${session.id}] ${action} transport: ${code ?? "<none>"} ${message}`,
      );
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        throw new Error(
          "demo session pod has not registered DNS yet — try again in a few seconds",
        );
      }
      if (code === "ECONNREFUSED") {
        throw new Error(
          "demo session pod is booting — try again once status='live'",
        );
      }
      throw new Error(`demo ${action} unreachable: ${message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`demo ${action} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json().catch(() => ({ ok: true }));
  }

  /**
   * Look up the demo session row that owns a (match_map_id, user)
   * pair. Returns null if there's no active session — the web should
   * call watchDemo first.
   */
  private async findDemoSession(matchMapId: string, userSteamId: string) {
    const { match_demo_sessions } = (await this.hasura.query({
      match_demo_sessions: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            watcher_steam_id: { _eq: userSteamId },
          },
          limit: 1,
        },
        id: true,
        k8s_job_name: true,
        session_token: true,
        status: true,
      },
    } as any)) as any;
    return match_demo_sessions?.[0] as
      | { id: string; k8s_job_name: string; session_token: string; status: string }
      | undefined;
  }

  /**
   * Public heartbeat — bumps last_activity_at without doing anything
   * else. Returns silently if there's no active session for this user
   * (e.g. the popup raced the reaper / a user-initiated stop). The
   * web treats absence of an active session as the cue to close itself.
   *
   * Single-shot update: at 10s/heartbeat × N concurrent sessions a
   * read-then-write would double the DB load. The (match_map_id,
   * watcher_steam_id) unique index makes the where-clause update
   * O(1).
   */
  public async pingDemoSession(matchMapId: string, userSteamId: string) {
    await this.hasura.mutation({
      update_match_demo_sessions: {
        __args: {
          where: {
            match_map_id: { _eq: matchMapId },
            watcher_steam_id: { _eq: userSteamId },
          },
          _set: { last_activity_at: "now()" },
        },
        affected_rows: true,
      },
    } as any);
  }

  private async bumpDemoSessionActivity(sessionId: string) {
    await this.hasura.mutation({
      update_match_demo_sessions_by_pk: {
        __args: {
          pk_columns: { id: sessionId },
          _set: { last_activity_at: "now()" },
        },
        id: true,
      },
    } as any);
  }

  /**
   * Validate a status-reporter POST. The streamer pod is started with
   * a per-session token; on every status POST it sends `x-origin-auth:
   * <session_id>:<token>`. We compare the token against what we stored
   * at session creation. Constant-time comparison via the existing
   * helper.
   */
  public async validateDemoSessionAuth(
    sessionId: string,
    originAuth: unknown,
  ): Promise<{ id: string; match_id: string; match_map_id: string } | null> {
    if (!originAuth || typeof originAuth !== "string") {
      return null;
    }
    const colonIndex = originAuth.indexOf(":");
    if (colonIndex === -1) {
      return null;
    }
    const headerSessionId = originAuth.substring(0, colonIndex);
    const presentedToken = originAuth.substring(colonIndex + 1);

    if (!timingSafeStringEqual(headerSessionId, sessionId)) {
      return null;
    }

    const { match_demo_sessions } = (await this.hasura.query({
      match_demo_sessions: {
        __args: {
          where: { id: { _eq: sessionId } },
          limit: 1,
        },
        id: true,
        match_id: true,
        match_map_id: true,
        session_token: true,
      },
    } as any)) as any;
    const row = match_demo_sessions?.[0];
    if (!row?.session_token) return null;

    if (!timingSafeStringEqual(row.session_token, presentedToken)) {
      return null;
    }

    return {
      id: row.id,
      match_id: row.match_id,
      match_map_id: row.match_map_id,
    };
  }

  /**
   * Receive a status update from a demo session pod. Mirrors
   * reportStatus (live), but writes to match_demo_sessions instead
   * of match_streams. The web subscription on the row picks it up
   * automatically.
   *
   * Important: we do NOT update stream_url here. The streamer pod
   * reports its SRT publish URL (cluster-internal, useless to a
   * browser); the api set the proper HLS URL on the row at insert
   * time and that's what the web consumes. body.stream_url is kept
   * around for debug logging only.
   */
  public async reportDemoStatus(
    sessionId: string,
    body: GameStreamerStatusDto,
  ) {
    // Read-modify-write the history so we can cap its length. Hasura
    // jsonb _append has no built-in trim, and a stuck pod cycling
    // statuses would otherwise grow this column without bound. Single
    // writer per session (the streamer pod) makes the lack of atomicity
    // safe in practice.
    const { match_demo_sessions_by_pk: current } = (await this.hasura.query({
      match_demo_sessions_by_pk: {
        __args: { id: sessionId },
        status_history: true,
      },
    } as any)) as any;

    if (!current) {
      this.logger.warn(
        `[demo ${sessionId}] reportDemoStatus: row missing — was the session torn down?`,
      );
      return;
    }

    const previous = Array.isArray(current.status_history)
      ? (current.status_history as unknown[])
      : [];
    const nextHistory = [
      ...previous,
      { status: body.status, at: new Date().toISOString() },
    ].slice(-STATUS_HISTORY_CAP);

    await this.hasura.mutation({
      update_match_demo_sessions_by_pk: {
        __args: {
          pk_columns: { id: sessionId },
          _set: {
            status: body.status,
            error_message: body.error ?? null,
            last_status_at: "now()",
            status_history: nextHistory,
          },
        },
        id: true,
      },
    } as any);

    this.logger.log(
      `[demo ${sessionId}] status=${body.status}${body.error ? ` err=${body.error}` : ""}`,
    );
  }

  private async createDemoService(sessionId: string) {
    const serviceName = GameStreamerService.GetDemoServiceNameForSession(sessionId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);

    await this.deleteDemoService(sessionId);

    const body: V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: serviceName,
        labels: {
          app: "game-streamer",
          role: "demo",
          "session-id": sessionId,
        },
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: "game-streamer",
          role: "demo",
          "session-id": sessionId,
        },
        ports: [
          { name: "openhud", port: 1349, targetPort: "openhud" as any },
          { name: "spec", port: 1350, targetPort: "spec" as any },
        ],
      },
    };

    await core.createNamespacedService({
      namespace: this.namespace,
      body,
    });
  }

  private async deleteDemoService(sessionId: string) {
    const serviceName = GameStreamerService.GetDemoServiceNameForSession(sessionId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);
    try {
      await core.deleteNamespacedService({
        name: serviceName,
        namespace: this.namespace,
      });
    } catch (error) {
      if (error.code?.toString() !== "404") {
        throw error;
      }
    }
  }

  /**
   * Reap demo sessions whose `last_activity_at` is older than
   * `idleSeconds` (default 60s — the popup pings every 10s, so 6
   * missed pings means the window is gone). The DB is the source of
   * truth — the spec-server doesn't need to be reachable for the
   * reaper to work, which means we still clean up after a crashed
   * pod.
   *
   * After the row-based sweep we also reap orphan k8s resources by
   * label — Jobs / Services that no longer have a matching row. This
   * catches the rare case where row deletion succeeded but k8s
   * teardown failed in `stopDemoSessionById`.
   */
  public async reapIdleDemoSessions(idleSeconds = 60) {
    // ISO timestamp `idleSeconds` in the past — anything older is
    // due for reaping. Postgres compares timestamptz values directly.
    const threshold = new Date(Date.now() - idleSeconds * 1000).toISOString();

    const { match_demo_sessions } = (await this.hasura.query({
      match_demo_sessions: {
        __args: {
          where: {
            last_activity_at: { _lt: threshold },
          },
        },
        id: true,
        k8s_job_name: true,
        last_activity_at: true,
      },
    } as any)) as any;

    for (const session of match_demo_sessions ?? []) {
      this.logger.log(
        `[demo ${session.id}] idle since ${session.last_activity_at} — reaping`,
      );
      try {
        await this.stopDemoSessionById(session.id, session.k8s_job_name);
      } catch (error) {
        this.logger.error(
          `[demo ${session.id}] reaper teardown failed: ${(error as Error)?.message}`,
        );
      }
    }

    await this.reapOrphanDemoK8sResources();
  }

  /**
   * Cluster-side orphan sweep. Lists demo-role Jobs and Services by
   * label, looks up the `session-id` label, and tears down anything
   * whose row no longer exists. Keeps `stopDemoSessionById` simple —
   * even when the row deletion outpaces k8s teardown, this catches it
   * within one reaper interval.
   */
  private async reapOrphanDemoK8sResources() {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);
    const core = kc.makeApiClient(CoreV1Api);

    const labelSelector = "app=game-streamer,role=demo";

    let jobSessionIds: string[] = [];
    let serviceSessionIds: string[] = [];
    try {
      const jobs = await batch.listNamespacedJob({
        namespace: this.namespace,
        labelSelector,
      });
      jobSessionIds = jobs.items
        .map((j) => j.metadata?.labels?.["session-id"])
        .filter((id): id is string => !!id);
    } catch (error) {
      this.logger.error(
        `[demo-reaper] listJobs failed: ${(error as Error)?.message}`,
      );
    }
    try {
      const services = await core.listNamespacedService({
        namespace: this.namespace,
        labelSelector,
      });
      serviceSessionIds = services.items
        .map((s) => s.metadata?.labels?.["session-id"])
        .filter((id): id is string => !!id);
    } catch (error) {
      this.logger.error(
        `[demo-reaper] listServices failed: ${(error as Error)?.message}`,
      );
    }

    const allClusterIds = Array.from(
      new Set([...jobSessionIds, ...serviceSessionIds]),
    );
    if (allClusterIds.length === 0) return;

    const { match_demo_sessions } = (await this.hasura.query({
      match_demo_sessions: {
        __args: {
          where: { id: { _in: allClusterIds } },
        },
        id: true,
      },
    } as any)) as any;
    const liveIds = new Set<string>(
      (match_demo_sessions ?? []).map((s: { id: string }) => s.id),
    );

    for (const sessionId of allClusterIds) {
      if (liveIds.has(sessionId)) continue;
      const jobName = GameStreamerService.GetDemoJobIdForSession(sessionId);
      this.logger.warn(
        `[demo ${sessionId}] orphan k8s resources (no row) — tearing down job=${jobName}`,
      );
      try {
        await this.deleteJob(jobName);
      } catch (error) {
        this.logger.error(
          `[demo ${sessionId}] orphan deleteJob failed: ${(error as Error)?.message}`,
        );
      }
      try {
        await this.deleteDemoService(sessionId);
      } catch (error) {
        this.logger.error(
          `[demo ${sessionId}] orphan deleteService failed: ${(error as Error)?.message}`,
        );
      }
    }
  }

  public async startLive(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        region: true,
        password: true,
        server: {
          host: true,
          port: true,
          tv_port: true,
        },
      },
    });

    if (!match) {
      throw new Error(`match ${matchId} not found`);
    }

    if (!match.server) {
      throw new Error("no server assigned for match");
    }

    const usePlaycast = await this.readUsePlaycast();

    const nodeId = await this.pickGpuNode(match.region);

    const connectEnv = await this.buildConnectEnv(
      matchId,
      match.server,
      match.password,
      usePlaycast,
    );

    const reporterEnv: V1EnvVar[] = [
      { name: "MATCH_PASSWORD", value: match.password },
    ];

    const jobName = GameStreamerService.GetLiveJobId(matchId);

    await this.deleteJob(jobName);

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    this.logger.log(`[${matchId}] starting live stream on node ${nodeId}`);

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJobSpec(jobName, matchId, "live", nodeId, [
        ...connectEnv,
        ...reporterEnv,
      ]),
    });

    await this.createLiveService(matchId);

    await this.registerStreamRow(matchId);
  }

  public async stopLive(matchId: string) {
    const jobName = GameStreamerService.GetLiveJobId(matchId);
    this.logger.log(`[${matchId}] stopping live stream`);

    let kubeError: unknown = null;
    try {
      await this.deleteJob(jobName);
    } catch (error) {
      kubeError = error;
      this.logger.error(
        `[${matchId}] deleteJob failed: ${(error as Error)?.message}`,
      );
    }

    try {
      await this.deleteLiveService(matchId);
    } catch (error) {
      this.logger.error(
        `[${matchId}] deleteLiveService failed: ${(error as Error)?.message}`,
      );
    }

    try {
      await this.unregisterStreamRow(matchId);
    } catch (error) {
      this.logger.error(
        `[${matchId}] unregisterStreamRow failed: ${(error as Error)?.message}`,
      );
      throw kubeError ?? error;
    }

    if (kubeError) {
      throw kubeError;
    }
  }

  public async createClips(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        region: true,
      },
    });

    if (!match) {
      throw new Error(`match ${matchId} not found`);
    }

    const nodeId = await this.pickGpuNode(match.region);

    const jobName = GameStreamerService.GetClipsJobId(matchId);

    await this.deleteJob(jobName);

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    this.logger.log(`[${matchId}] creating clips on node ${nodeId}`);

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJobSpec(jobName, matchId, "create-clips", nodeId, []),
    });
  }

  private async readUsePlaycast(): Promise<boolean> {
    const { settings_by_pk } = await this.hasura.query({
      settings_by_pk: {
        __args: { name: "use_playcast" },
        name: true,
        value: true,
      },
    });
    return settings_by_pk?.value === "true";
  }

  private async pickGpuNode(matchRegion: string | null): Promise<string> {
    const baseWhere = {
      status: {
        _eq: "Online" as e_game_server_node_statuses_enum,
      },
      enabled: { _eq: true },
      gpu: { _eq: true },
    };

    let { game_server_nodes: nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: matchRegion
            ? { ...baseWhere, region: { _eq: matchRegion } }
            : baseWhere,
        },
        id: true,
      },
    });

    if (nodes.length === 0 && matchRegion) {
      ({ game_server_nodes: nodes } = await this.hasura.query({
        game_server_nodes: {
          __args: { where: baseWhere },
          id: true,
        },
      }));
    }

    if (nodes.length === 0) {
      throw new Error("no GPU-capable game node available");
    }

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    const jobs = await batch.listNamespacedJob({
      namespace: this.namespace,
      labelSelector: "app=game-streamer",
    });

    const usagePerNode = new Map<string, number>();
    for (const node of nodes) {
      usagePerNode.set(node.id, 0);
    }
    for (const job of jobs.items) {
      const pinnedNode =
        job.spec?.template?.spec?.affinity?.nodeAffinity
          ?.requiredDuringSchedulingIgnoredDuringExecution
          ?.nodeSelectorTerms?.[0]?.matchExpressions?.[0]?.values?.[0];
      if (pinnedNode && usagePerNode.has(pinnedNode)) {
        usagePerNode.set(pinnedNode, (usagePerNode.get(pinnedNode) ?? 0) + 1);
      }
    }

    let chosen = nodes[0].id;
    let chosenLoad = usagePerNode.get(chosen) ?? 0;
    for (const node of nodes) {
      const load = usagePerNode.get(node.id) ?? 0;
      if (load < chosenLoad) {
        chosen = node.id;
        chosenLoad = load;
      }
    }

    return chosen;
  }

  private async buildConnectEnv(
    matchId: string,
    server: {
      host: string;
      port: number;
      tv_port: number | null;
    },
    matchPassword: string,
    usePlaycast: boolean,
  ): Promise<V1EnvVar[]> {
    if (usePlaycast) {
      return [
        { name: "PLAYCAST_URL", value: `https://tv.5stack.gg/${matchId}` },
        { name: "PLAYCAST_PASSWORD", value: "" },
      ];
    }

    if (server.tv_port) {
      return [
        {
          name: "CONNECT_TV_ADDR",
          value: `${server.host}:${server.tv_port}`,
        },
        { name: "CONNECT_TV_PASSWORD", value: matchPassword },
      ];
    }

    return [
      { name: "CONNECT_ADDR", value: `${server.host}:${server.port}` },
      { name: "CONNECT_PASSWORD", value: `tv:user:${matchPassword}` },
    ];
  }

  private async createLiveService(matchId: string) {
    const serviceName = GameStreamerService.GetLiveServiceName(matchId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);

    await this.deleteLiveService(matchId);

    const body: V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: serviceName,
        labels: {
          app: "game-streamer",
          role: "live",
          "match-id": matchId,
        },
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: "game-streamer",
          role: "live",
          "match-id": matchId,
        },
        ports: [
          { name: "openhud", port: 1349, targetPort: "openhud" as any },
          { name: "spec", port: 1350, targetPort: "spec" as any },
        ],
      },
    };

    await core.createNamespacedService({
      namespace: this.namespace,
      body,
    });
  }

  private async deleteLiveService(matchId: string) {
    const serviceName = GameStreamerService.GetLiveServiceName(matchId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);
    try {
      await core.deleteNamespacedService({
        name: serviceName,
        namespace: this.namespace,
      });
    } catch (error) {
      if (error.code?.toString() !== "404") {
        throw error;
      }
    }
  }

  private async deleteJob(jobName: string) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);
    const batch = kc.makeApiClient(BatchV1Api);

    const pods = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
    });

    for (const pod of pods.items) {
      await core
        .deleteNamespacedPod({
          name: pod.metadata!.name!,
          namespace: this.namespace,
          gracePeriodSeconds: 0,
        })
        .catch((error) => {
          if (error.code?.toString() !== "404") {
            throw error;
          }
        });
    }

    await batch
      .deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        propagationPolicy: "Background",
        gracePeriodSeconds: 0,
      })
      .catch((error) => {
        if (error.code?.toString() !== "404") {
          throw error;
        }
      });

    // Avoid a create/delete race while Kubernetes releases the Job name.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await batch.readNamespacedJob({
          name: jobName,
          namespace: this.namespace,
        });
      } catch (error) {
        if (error.code?.toString() === "404") {
          return;
        }
        throw error;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private async registerStreamRow(matchId: string) {
    await this.unregisterStreamRow(matchId);
    // `booting` is the implicit api-side stage between "row inserted"
    // and "K8s schedules + pulls + starts the pod". The streamer pod
    // doesn't push that status itself (it only starts emitting once
    // setup-steam.sh runs), so we seed status_history here. Without
    // this seed, the stepper would render "Allocating GPU pod" as
    // skipped — but it's the one stage that is always required.
    const nowIso = new Date().toISOString();
    await this.hasura.mutation({
      insert_match_streams_one: {
        __args: {
          object: {
            match_id: matchId,
            title: GAME_STREAMER_TITLE,
            link: `${this.appConfig.gameStreamHlsBase}/${matchId}/`,
            priority: 0,
            is_game_streamer: true,
            is_live: false,
            status: "booting",
            status_history: [{ status: "booting", at: nowIso }],
            last_status_at: "now()",
          } as any,
        },
        id: true,
      },
    });
  }

  public async validateStatusOriginAuth(
    matchId: string,
    originAuth: unknown,
  ): Promise<boolean> {
    if (!originAuth || typeof originAuth !== "string") {
      return false;
    }
    const colonIndex = originAuth.indexOf(":");
    if (colonIndex === -1) {
      return false;
    }
    const headerMatchId = originAuth.substring(0, colonIndex);
    const apiPassword = originAuth.substring(colonIndex + 1);

    if (!timingSafeStringEqual(headerMatchId, matchId)) {
      return false;
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        password: true,
      },
    });

    const matchPassword = match?.password ?? null;

    if (!matchPassword || typeof matchPassword !== "string") {
      return false;
    }

    return timingSafeStringEqual(matchPassword, apiPassword);
  }

  public async reportStatus(matchId: string, body: GameStreamerStatusDto) {
    // Read-modify-write so we can cap status_history length. Stuck
    // pods that bounce statuses would otherwise grow the column
    // unbounded. One writer per match (the streamer pod) — race-free
    // in practice.
    const { match_streams } = (await this.hasura.query({
      match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
          limit: 1,
        },
        status_history: true,
      },
    } as any)) as any;
    const previous = Array.isArray(match_streams?.[0]?.status_history)
      ? (match_streams[0].status_history as unknown[])
      : [];
    const nextHistory = [
      ...previous,
      { status: body.status, at: new Date().toISOString() },
    ].slice(-STATUS_HISTORY_CAP);

    const setClause = {
      status: body.status,
      stream_url: body.stream_url ?? null,
      error_message: body.error ?? null,
      last_status_at: "now()",
      is_live: body.status === "live",
      status_history: nextHistory,
    };

    const result = await this.hasura.mutation({
      update_match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
          _set: setClause as any,
        },
        affected_rows: true,
      },
    });

    const updated = result.update_match_streams.affected_rows;
    this.logger.log(
      `[${matchId}] reportStatus status=${body.status} updated=${updated}`,
    );

    if (updated === 0) {
      this.logger.log(
        `[${matchId}] no existing row — falling back to delete + insert`,
      );
      await this.hasura.mutation({
        delete_match_streams: {
          __args: {
            where: {
              match_id: { _eq: matchId },
              is_game_streamer: { _eq: true },
            },
          },
          affected_rows: true,
        },
        insert_match_streams_one: {
          __args: {
            object: {
              match_id: matchId,
              title: GAME_STREAMER_TITLE,
              link: `${this.appConfig.gameStreamHlsBase}/${matchId}/`,
              priority: 0,
              is_game_streamer: true,
              // setClause already includes status_history (capped) —
              // it seeds the new row's stepper with this observed
              // status so the UI doesn't render blank.
              ...setClause,
            } as any,
          },
          id: true,
        },
      });
      this.logger.log(`[${matchId}] inserted new match_streams row`);
    }

    if (body.status === "live") {
      this.logger.log(`[${matchId}] "${GAME_STREAMER_TITLE}" → live`);
    } else if (body.status === "errored") {
      this.logger.warn(
        `[${matchId}] streamer errored: ${body.error ?? "<no message>"}`,
      );
    }
  }

  private async unregisterStreamRow(matchId: string) {
    await this.hasura.mutation({
      delete_match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
        },
        affected_rows: true,
      },
    });
  }

  private buildJobSpec(
    jobName: string,
    matchId: string,
    mode: StreamerMode,
    nodeId: string,
    extraEnv: V1EnvVar[],
    extraLabels: Record<string, string> = {},
  ): V1Job {
    const containerName =
      mode === "create-clips" ? "clips" : mode === "demo" ? "demo" : "live";
    // The streamer.sh top-level subcommand. demo flow re-uses
    // setup-steam, then run-demo.sh. --debug publishes a public
    // Steam/CS2 boot stream — gated on DEMO_DEBUG_STREAM env so
    // it's off by default in production.
    const args =
      mode === "live"
        ? ["live"]
        : mode === "demo"
          ? ["demo"]
          : ["create-clips"];
    // Both live and demo expose openhud + spec-server. create-clips
    // doesn't, since no operator interacts with it.
    const exposesSpecPorts = mode === "live" || mode === "demo";

    const labels: Record<string, string> = {
      app: "game-streamer",
      role: mode,
      "match-id": matchId,
      ...extraLabels,
    };

    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        labels,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 60 * 60 * 24,
        template: {
          metadata: {
            labels,
          },
          spec: {
            restartPolicy: "Never",
            runtimeClassName: "nvidia",
            affinity: {
              nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        {
                          key: "kubernetes.io/hostname",
                          operator: "In",
                          values: [nodeId],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            initContainers: [
              {
                name: "prep-cache",
                image: "busybox:1.36",
                command: [
                  "sh",
                  "-c",
                  "mkdir -p /mnt/game-streamer/steam /mnt/game-streamer/steamapps /mnt/game-streamer/demos /mnt/game-streamer/clips",
                ],
                volumeMounts: [
                  { name: "cache", mountPath: "/mnt/game-streamer" },
                ],
              },
            ],
            containers: [
              {
                name: containerName,
                image: "ghcr.io/5stackgg/game-streamer:latest",
                // Mutable tag; force each pod start to resolve the latest digest.
                imagePullPolicy: "Always",
                securityContext: { privileged: true },
                args,
                ports: exposesSpecPorts
                  ? [
                      { name: "openhud", containerPort: 1349 },
                      { name: "spec", containerPort: 1350 },
                    ]
                  : undefined,
                env: [
                  { name: "MATCH_ID", value: matchId },
                  { name: "DISPLAY_SIZEW", value: "1920" },
                  { name: "DISPLAY_SIZEH", value: "1080" },
                  { name: "OPENHUD_AUTO_OVERLAY", value: "1" },
                  ...extraEnv,
                ],
                envFrom: [{ secretRef: { name: "steam-secrets" } }],
                resources: {
                  limits: {
                    memory: "16Gi",
                    cpu: "8",
                    "nvidia.com/gpu": "1",
                  },
                  requests: {
                    memory: "2Gi",
                    cpu: "1",
                    "nvidia.com/gpu": "1",
                  },
                },
                volumeMounts: [
                  { name: "dshm", mountPath: "/dev/shm" },
                  // Keep Steam on one mount; a second subPath mount caused EXDEV.
                  { name: "cache", mountPath: "/mnt/game-streamer" },
                ],
              },
            ],
            volumes: [
              {
                name: "dshm",
                emptyDir: { medium: "Memory", sizeLimit: "2Gi" },
              },
              {
                name: "cache",
                hostPath: {
                  path: "/opt/5stack/game-streamer",
                  type: "DirectoryOrCreate",
                },
              },
            ],
          },
        },
      },
    };
  }
}
