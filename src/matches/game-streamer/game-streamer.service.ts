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
import { S3Service } from "../../s3/s3.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";
import { e_game_server_node_statuses_enum } from "../../../generated";
import { AppConfig } from "../../configs/types/AppConfig";
import { randomBytes } from "node:crypto";

type StreamerMode = "live" | "create-clips" | "demo" | "batch-highlights";

export type DemoControlAction =
  | "pause"
  | "resume"
  | "toggle"
  | "seek"
  | "skip"
  | "speed"
  | "round"
  | "state"
  | "slot"
  | "reload"
  | "xray"
  | "hud"
  | "demoui";

export const DEMO_CONTROL_ACTIONS: ReadonlySet<DemoControlAction> =
  new Set<DemoControlAction>([
    "pause",
    "resume",
    "toggle",
    "seek",
    "skip",
    "speed",
    "round",
    "state",
    "slot",
    "reload",
    "xray",
    "hud",
    "demoui",
  ]);

const SPEC_PROXIED_DEMO_ACTIONS: ReadonlySet<DemoControlAction> =
  new Set<DemoControlAction>(["slot", "hud"]);

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
    private readonly s3: S3Service,
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

  // GET the live pod's spec-server /demo/state. Same payload shape as
  // the demo route — spec-server.mjs is one binary, so live/demo
  // pods both expose `gsi.spec_slots` once GSI fires. We strip the
  // demo-only fields (tick, paused, etc.) so callers don't think the
  // live route exposes things it doesn't.
  public async getLiveSpecState(matchId: string): Promise<{
    gsi: {
      map_name: string | null;
      map_phase: string | null;
      round_phase: string | null;
      round_number: number | null;
      spectated_steam_id: string | null;
      spec_slots: Array<{
        slot: number;
        steam_id: string;
        name: string | null;
        team: "T" | "CT" | null;
        alive: boolean;
        health: number;
      }>;
      team_ct_name: string | null;
      team_t_name: string | null;
      team_ct_score: number;
      team_t_score: number;
    } | null;
  }> {
    const svc = GameStreamerService.GetLiveServiceName(matchId);
    const url = `http://${svc}.${this.namespace}.svc.cluster.local:1350/demo/state`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    } catch (error) {
      const cause = (error as Error)?.cause as { code?: string } | undefined;
      const code = cause?.code ?? (error as { code?: string })?.code;
      if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
        // Live pod not up yet — return empty so the UI can show the
        // existing offline state without a noisy error.
        return { gsi: null };
      }
      throw new Error(`spec state unreachable: ${(error as Error)?.message}`);
    }
    if (!res.ok) {
      return { gsi: null };
    }
    const body = (await res.json().catch(() => ({}))) as { gsi?: any };
    return { gsi: body?.gsi ?? null };
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
          _set: { autodirector: enabled },
        },
        affected_rows: true,
      },
    });
    return result;
  }

  public static GetClipsJobId(matchId: string) {
    return `gs-clips-${matchId}`;
  }

  public static GetDemoJobIdForSession(sessionId: string) {
    return `gs-demo-${sessionId.replace(/-/g, "").slice(0, 12)}`;
  }
  public static GetDemoServiceNameForSession(sessionId: string) {
    return GameStreamerService.GetDemoJobIdForSession(sessionId);
  }

  private getDemoSpecUrl(
    sessionId: string,
    action: string,
    prefix: "demo" | "spec" = "demo",
  ) {
    const svc = GameStreamerService.GetDemoServiceNameForSession(sessionId);
    return `http://${svc}.${this.namespace}.svc.cluster.local:1350/${prefix}/${action}`;
  }

  public async startDemoPlayback(
    matchMapId: string,
    userSteamId: string,
    options: {
      demoFile: string;
      presignedDemoUrl: string;
      roundTicks: unknown;
      totalTicks: number | null;
      tickRate: number | null;
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

    const existing = await this.findDemoSession(matchMapId, userSteamId);
    if (existing) {
      this.logger.log(
        `[demo] tearing down stale session ${existing.id} for ${userSteamId} on ${matchMapId} before new start`,
      );
      await this.stopDemoSessionById(existing.id, existing.k8s_job_name);
    }

    const sessionToken = randomBytes(24).toString("hex");

    const streamUrl = `${this.appConfig.gameStreamHlsBase}/${matchId}/`;

    const bootIso = new Date().toISOString();
    const { insert_match_demo_sessions_one } = await this.hasura.mutation({
      insert_match_demo_sessions_one: {
        __args: {
          object: {
            match_id: matchId,
            match_map_id: matchMapId,
            watcher_steam_id: userSteamId,
            k8s_job_name: "pending",
            session_token: sessionToken,
            stream_url: streamUrl,
            status: "booting",
            status_history: [{ status: "booting", at: bootIso }],
          },
        },
        id: true,
      },
    });
    const sessionId = insert_match_demo_sessions_one?.id;
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
    });

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
      env.push({
        name: "ROUND_TICKS",
        value: JSON.stringify(options.roundTicks),
      });
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
    });
  }

  public async demoControl(
    matchMapId: string,
    userSteamId: string,
    action: DemoControlAction,
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!DEMO_CONTROL_ACTIONS.has(action)) {
      throw new Error(`unsupported demo control action: ${action}`);
    }

    const session = await this.findDemoSession(matchMapId, userSteamId);
    if (!session) {
      throw new Error(
        "no demo playback session is running — call watchDemo first",
      );
    }

    await this.bumpDemoSessionActivity(session.id);

    const prefix = SPEC_PROXIED_DEMO_ACTIONS.has(action) ? "spec" : "demo";
    const url = this.getDemoSpecUrl(session.id, action, prefix);
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

  // Returns when the pod accepts the request, not when render finishes
  // — progress comes back via /clip-renders/:id/status.
  public async dispatchClipRenderToPod(
    sessionId: string,
    payload: {
      job_id: string;
      token: string;
      api_base: string;
      segments: Array<{
        start_tick: number;
        end_tick: number;
        pov_steam_id?: string;
      }>;
      output_dims: string;
      output_fps: number;
      render_speed?: number;
    },
  ) {
    const url = this.getDemoSpecUrl(sessionId, "render-clip", "demo");
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      const cause = (error as Error)?.cause as { code?: string } | undefined;
      const code = cause?.code ?? (error as { code?: string })?.code;
      const message = (error as Error)?.message ?? String(error);
      this.logger.error(
        `[clip dispatch] transport: ${code ?? "<none>"} ${message} url=${url}`,
      );
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        throw new Error(
          "demo session pod has not registered DNS yet — try again in a few seconds",
        );
      }
      if (code === "ECONNREFUSED") {
        throw new Error(
          "demo session pod is up but spec-server is not listening yet",
        );
      }
      throw new Error(`spec-server render-clip unreachable: ${message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `spec-server render-clip -> ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  }

  private async findDemoSession(matchMapId: string, userSteamId: string) {
    const { match_demo_sessions } = await this.hasura.query({
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
    });
    return match_demo_sessions?.[0];
  }

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
    });
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
    });
  }

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

    const { match_demo_sessions } = await this.hasura.query({
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
    });
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

  public async reportDemoStatus(
    sessionId: string,
    body: GameStreamerStatusDto,
  ) {
    const { match_demo_sessions_by_pk: current } = await this.hasura.query({
      match_demo_sessions_by_pk: {
        __args: { id: sessionId },
        status_history: true,
      },
    });

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
    });

    this.logger.log(
      `[demo ${sessionId}] status=${body.status}${body.error ? ` err=${body.error}` : ""}`,
    );
  }

  private async createDemoService(sessionId: string) {
    const serviceName =
      GameStreamerService.GetDemoServiceNameForSession(sessionId);
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
          { name: "openhud", port: 1349, targetPort: "openhud" },
          { name: "spec", port: 1350, targetPort: "spec" },
        ],
      },
    };

    await core.createNamespacedService({
      namespace: this.namespace,
      body,
    });
  }

  private async deleteDemoService(sessionId: string) {
    const serviceName =
      GameStreamerService.GetDemoServiceNameForSession(sessionId);
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

  public async reapIdleDemoSessions(idleSeconds = 60) {
    const threshold = new Date(Date.now() - idleSeconds * 1000).toISOString();

    const { match_demo_sessions } = await this.hasura.query({
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
    });

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

    const { match_demo_sessions } = await this.hasura.query({
      match_demo_sessions: {
        __args: {
          where: { id: { _in: allClusterIds } },
        },
        id: true,
      },
    });
    const liveIds = new Set<string>(
      (match_demo_sessions ?? []).map((s) => s.id),
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

  public static GetBatchHighlightsJobName(matchMapId: string) {
    // 12 chars from the hex of the match_map uuid keeps the k8s name
    // short + valid (kubernetes job names cap at 63). Stripping
    // dashes keeps the prefix simple to grep for in `kubectl get jobs`.
    return `gs-batch-${matchMapId.replace(/-/g, "").slice(0, 12)}`;
  }

  // Health probe for the BullMQ batch worker. Returns:
  //   - "running" if the k8s Job exists and has at least one active pod
  //   - "succeeded" if the Job completed cleanly
  //   - "failed" if the Job hit its backoff limit / image-pull error /
  //     etc. — i.e. there's a Job row but no live pod and it didn't
  //     reach completion
  //   - "absent" if no Job row exists (never dispatched, or already
  //     reaped via ttlSecondsAfterFinished)
  public async getBatchHighlightsPodState(
    matchMapId: string,
  ): Promise<"running" | "succeeded" | "failed" | "absent"> {
    const jobName = GameStreamerService.GetBatchHighlightsJobName(matchMapId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);
    let job;
    try {
      job = await batch.readNamespacedJob({
        name: jobName,
        namespace: this.namespace,
      });
    } catch (error) {
      if ((error as { code?: number | string }).code?.toString() === "404") {
        return "absent";
      }
      throw error;
    }
    const status = job.status ?? {};
    if ((status.active ?? 0) > 0) return "running";
    if ((status.succeeded ?? 0) > 0) return "succeeded";
    if ((status.failed ?? 0) > 0) return "failed";
    // No active/succeeded/failed counter populated yet — still
    // initialising. Treat as running so the worker waits one more
    // tick before redispatching.
    return "running";
  }

  // Best-effort "why did the pod die" probe. Reads the most recent
  // pod for the batch Job and returns a short, operator-friendly
  // string built from container terminated reason + last log line.
  // Used by the BullMQ worker to record a useful error_message on
  // failed clip_render_jobs rows instead of "render pod failed"
  // with no further detail. Returns null when nothing meaningful
  // is available (no pod, no terminated container, no logs).
  public async getBatchPodFailureReason(
    matchMapId: string,
  ): Promise<string | null> {
    const jobName = GameStreamerService.GetBatchHighlightsJobName(matchMapId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);
    let pods;
    try {
      pods = await core.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `job-name=${jobName}`,
      });
    } catch (error) {
      this.logger.warn(
        `[batch-highlights ${matchMapId}] failure-reason listPods: ${(error as Error)?.message}`,
      );
      return null;
    }
    // Newest first — when k8s recreated the pod after a backoff,
    // the most recent attempt is the most informative.
    const sorted = [...(pods.items ?? [])].sort((a, b) => {
      const ta = new Date(a.metadata?.creationTimestamp ?? 0).getTime();
      const tb = new Date(b.metadata?.creationTimestamp ?? 0).getTime();
      return tb - ta;
    });
    const pod = sorted[0];
    if (!pod?.metadata?.name) return null;

    const term = pod.status?.containerStatuses?.[0]?.lastState?.terminated
      ?? pod.status?.containerStatuses?.[0]?.state?.terminated;
    const reason = term?.reason ?? null;
    const exitCode = term?.exitCode ?? null;

    // Tail a few lines of stdout/stderr — usually enough to surface
    // the obvious "demo download 403" / "ENOTFOUND" / etc. without
    // dumping a multi-hundred-line setup log into the row.
    let logTail: string | null = null;
    try {
      const logs = await core.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.namespace,
        tailLines: 5,
      });
      const lines = String(logs ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length > 0) logTail = lines.join(" | ");
    } catch {
      // logs may not be available (pod evicted before logs were
      // collected). Fall through; reason+exit are usually enough.
    }

    const parts: string[] = [];
    if (reason) parts.push(reason);
    if (exitCode != null) parts.push(`exit=${exitCode}`);
    if (logTail) parts.push(logTail);
    if (parts.length === 0) return null;
    return parts.join(" — ").slice(0, 500);
  }

  // Force-kill a batch pod (and its k8s Job). Used ONLY by the
  // explicit operator-triggered cancelClipRenderBatch flow now —
  // the watchdog no longer auto-kills failed Jobs, and there's no
  // "preemption on slow render" path. Idempotent — `absent` jobs
  // return cleanly.
  public async killBatchHighlightsPod(matchMapId: string): Promise<void> {
    const jobName = GameStreamerService.GetBatchHighlightsJobName(matchMapId);
    try {
      await this.deleteJob(jobName);
      this.logger.warn(
        `[batch-highlights ${matchMapId}] force-killed pod ${jobName}`,
      );
    } catch (error) {
      this.logger.error(
        `[batch-highlights ${matchMapId}] kill failed: ${(error as Error)?.message}`,
      );
    }
  }

  // Spawn ONE k8s Job that processes a batch of clip_render_jobs for
  // a single match_map. Pod loads cs2 + the demo once, then iterates
  // through every queued job in order, capturing each one against the
  // already-running cs2 instance. Significantly faster than per-job
  // pods because we skip the steam login + cs2 launch (~60-90s each)
  // for every clip after the first. Idempotent: if a batch is already
  // running for this match_map, this is a no-op.
  public async dispatchBatchHighlights(
    matchMapId: string,
    jobs: Array<{ job_id: string; session_token: string; spec: unknown }>,
  ): Promise<void> {
    if (jobs.length === 0) return;

    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: { match_map_id: { _eq: matchMapId } },
          limit: 1,
        },
        match_id: true,
        file: true,
        total_ticks: true,
        tick_rate: true,
        round_ticks: true,
        workshop_id: true,
        cs2_build: true,
      },
    });
    const demo = match_map_demos?.[0];
    if (!demo?.file) {
      throw new Error(
        `cannot dispatch batch highlights: no demo file for match_map ${matchMapId}`,
      );
    }
    const matchId = String(demo.match_id);

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        region: true,
      },
    });

    // 4-arg form mirrors watchDemo's call site
    // (matches.controller.ts → s3.getPresignedUrl(file, undefined,
    // 60*60, "get")). The default-arg form was wrong on two axes:
    // expiry defaults to ~5 minutes (the X-Amz-Expires=300 we saw
    // was getting close to elapsing by the time the pod's curl
    // ran), and method defaults to "put" (which Backblaze rejects
    // with 403 when the pod uses it for GET — sign-method must
    // match request-method).
    const presignedDemoUrl = await this.s3.getPresignedUrl(
      demo.file as string,
      undefined,
      60 * 60,
      "get",
    );
    const nodeId = await this.pickGpuNode(match?.region ?? null);
    const jobName = GameStreamerService.GetBatchHighlightsJobName(matchMapId);

    // Caller (BatchHighlightsRenderJob) guarantees no prior Job
    // exists by killBatchHighlightsPod-ing first. We don't second-
    // guess that here — the operator pressing "Create Player
    // Highlights" expects a fresh re-render every time, and silently
    // bailing on a leftover terminal Job (24h ttlSecondsAfterFinished)
    // is exactly what was leaving rows stuck in queued.
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    const env: V1EnvVar[] = [
      { name: "MATCH_ID", value: matchId },
      { name: "MATCH_MAP_ID", value: matchMapId },
      { name: "DEMO_URL", value: presignedDemoUrl },
      { name: "DEMO_FILE_NAME", value: demo.file as string },
      { name: "STATUS_API_BASE", value: this.resolveInClusterApiBase() },
      // Tells setup-steam.sh to skip OpenHud so rendered mp4s don't
      // bake in the spectator scoreboard/killfeed overlay.
      { name: "CLIP_BATCH_MODE", value: "1" },
      // CLIP_BATCH_JOBS is consumed by run-batch-highlights.sh — one
      // entry per clip_render_jobs row, with the spec fully resolved
      // so the pod doesn't need to re-query the api between renders.
      // Keeping the array compact (just the fields the script needs).
      {
        name: "CLIP_BATCH_JOBS",
        value: JSON.stringify(
          jobs.map((j) => ({
            job_id: j.job_id,
            token: j.session_token,
            spec: j.spec,
          })),
        ),
      },
    ];
    if (demo.tick_rate != null) {
      env.push({
        name: "DEMO_TICK_RATE",
        value: String(demo.tick_rate),
      });
    }
    if (demo.total_ticks != null) {
      env.push({
        name: "DEMO_TOTAL_TICKS",
        value: String(demo.total_ticks),
      });
    }
    if (demo.round_ticks != null) {
      env.push({
        name: "ROUND_TICKS",
        value: JSON.stringify(demo.round_ticks),
      });
    }
    if (demo.workshop_id) {
      env.push({ name: "WORKSHOP_ID", value: String(demo.workshop_id) });
    }
    if (demo.cs2_build) {
      env.push({ name: "CS2_BUILD", value: String(demo.cs2_build) });
    }

    this.logger.log(
      `[batch-highlights ${matchMapId}] dispatching ${jobs.length} job(s) to pod ${jobName} on node ${nodeId}`,
    );

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJobSpec(jobName, matchId, "batch-highlights", nodeId, env, {
        "match-map-id": matchMapId,
      }),
    });
  }

  private resolveInClusterApiBase(): string {
    return process.env.API_INTERNAL_BASE ?? "http://api:5585";
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
          { name: "openhud", port: 1349, targetPort: "openhud" },
          { name: "spec", port: 1350, targetPort: "spec" },
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
          },
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
    const { match_streams } = await this.hasura.query({
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
    });
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
          _set: setClause,
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
              ...setClause,
            },
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
      mode === "create-clips"
        ? "clips"
        : mode === "demo"
          ? "demo"
          : mode === "batch-highlights"
            ? "batch"
            : "live";
    const args =
      mode === "live"
        ? ["live"]
        : mode === "demo"
          ? ["demo"]
          : mode === "batch-highlights"
            ? ["batch-highlights"]
            : ["create-clips"];
    const exposesSpecPorts =
      mode === "live" || mode === "demo" || mode === "batch-highlights";

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
