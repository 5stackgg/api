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
import { Redis } from "ioredis";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";
import { DemoMetadataService } from "../../demos/demo-metadata.service";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import { GameStreamerStatusDto } from "./types/GameStreamerStatusDto";
import { AppConfig } from "../../configs/types/AppConfig";
import { SteamConfig } from "../../configs/types/SteamConfig";
import { resolveInClusterApiBase } from "../clips/clips.constants";
import { LoggingService } from "../../k8s/logging/logging.service";

// Snapshot TTL is a touch over 2x the producer's 30s cadence so a
// consumer reading mid-cycle always sees a fresh-or-just-stale frame.
const SNAPSHOT_REDIS_TTL_SECONDS = 75;
export type SnapshotKind = "live" | "demo" | "bake" | "clips";
const snapshotRedisKey = (kind: SnapshotKind, id: string) =>
  `gs:snapshot:${kind}:${id}`;

const STREAM_VIEWERS_TTL_SECONDS = 90;
const STREAM_VIEWERS_INDEX_KEY = "stream:viewers:index";
const streamViewersKey = (matchId: string) => `stream:viewers:${matchId}`;

type StreamerMode =
  | "live"
  | "create-clips"
  | "demo"
  | "batch-highlights"
  | "warm-shaders";

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
  | "hud-mode"
  | "hud-sides"
  | "demoui"
  | "autodirector"
  | "scoreboard"
  | "skip-shaders";

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
    "hud-mode",
    "hud-sides",
    "demoui",
    "autodirector",
    "scoreboard",
    "skip-shaders",
  ]);

const SPEC_PROXIED_DEMO_ACTIONS: ReadonlySet<DemoControlAction> =
  new Set<DemoControlAction>([
    "slot",
    "hud",
    "hud-mode",
    "hud-sides",
    "autodirector",
    "scoreboard",
    // routes to the demo pod's /spec/skip-shaders (drops the skip marker)
    "skip-shaders",
  ]);

const STATUS_HISTORY_CAP = 50;

const GAME_STREAMER_TITLE = "5Stack Game Streamer";

export class NoGpuAvailableError extends Error {
  constructor(message = "no GPU available") {
    super(message);
    this.name = "NoGpuAvailableError";
  }
}

export class NodeBusyError extends Error {
  constructor(message = "node is busy with an active session") {
    super(message);
    this.name = "NodeBusyError";
  }
}

export class NoSteamAccountAvailableError extends Error {
  constructor(
    message = "no Steam account available — add more accounts to the pool",
  ) {
    super(message);
    this.name = "NoSteamAccountAvailableError";
  }
}

export type ClaimedSteamAccount = {
  id: string;
  username: string;
  password: string;
};

export type GpuClaim = {
  nodeId: string;
  steamAccount: ClaimedSteamAccount;
};

@Injectable()
export class GameStreamerService {
  private readonly namespace: string;
  private readonly gameServerConfig: GameServersConfig;
  private readonly appConfig: AppConfig;
  private readonly steamConfig: SteamConfig;
  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly loggingService: LoggingService,
  ) {
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.appConfig = this.config.get<AppConfig>("app");
    this.steamConfig = this.config.get<SteamConfig>("steam");
    this.namespace = this.gameServerConfig.namespace;
    this.redis = this.redisManager.getConnection();
  }

  public async storeSnapshot(
    kind: SnapshotKind,
    id: string,
    image: Buffer,
  ): Promise<void> {
    if (!image || image.length === 0) {
      throw new Error("empty snapshot payload");
    }
    await this.redis.setex(
      snapshotRedisKey(kind, id),
      SNAPSHOT_REDIS_TTL_SECONDS,
      image,
    );
    await this.redis.publish(
      "broadcast-message",
      JSON.stringify({ event: "snapshot:updated", data: { kind, id } }),
    );
  }

  public async getSnapshot(
    kind: SnapshotKind,
    id: string,
  ): Promise<Buffer | null> {
    // getBuffer() preserves binary bytes; the string-typed get() would
    // re-encode JPEG bytes as utf8 and corrupt them.
    const buffer = await this.redis.getBuffer(snapshotRedisKey(kind, id));
    return buffer ?? null;
  }

  public async pollMediaMtxViewers(): Promise<void> {
    const base = process.env.MEDIAMTX_API_BASE || "http://mediamtx:9997";
    const url = `${base.replace(/\/$/, "")}/v3/paths/list`;

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } })
        ?.cause;
      throw new Error(
        `mediamtx ${url} fetch failed: ${cause?.code ?? cause?.message ?? (error as Error)?.message}`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `mediamtx ${url} returned ${res.status} ${res.statusText}`,
      );
    }

    const payload = (await res.json()) as {
      items?: Array<{ name?: string; readers?: unknown[] }>;
    };

    const counts = new Map<string, number>();
    for (const item of payload.items ?? []) {
      const matchId = item?.name;
      if (!matchId) continue;
      counts.set(
        matchId,
        Array.isArray(item.readers) ? item.readers.length : 0,
      );
    }

    const previous = await this.redis.smembers(STREAM_VIEWERS_INDEX_KEY);
    const pipeline = this.redis.pipeline();

    for (const [matchId, count] of counts) {
      pipeline.setex(
        streamViewersKey(matchId),
        STREAM_VIEWERS_TTL_SECONDS,
        String(count),
      );
      pipeline.sadd(STREAM_VIEWERS_INDEX_KEY, matchId);
    }

    for (const matchId of previous) {
      if (!counts.has(matchId)) {
        pipeline.del(streamViewersKey(matchId));
        pipeline.srem(STREAM_VIEWERS_INDEX_KEY, matchId);
      }
    }

    await pipeline.exec();
  }

  public async getStreamViewerCounts(
    matchIds?: string[],
  ): Promise<Record<string, number>> {
    const ids =
      matchIds && matchIds.length > 0
        ? matchIds
        : await this.redis.smembers(STREAM_VIEWERS_INDEX_KEY);

    if (ids.length === 0) {
      return {};
    }

    const values = await this.redis.mget(ids.map(streamViewersKey));
    const result: Record<string, number> = {};
    ids.forEach((id, index) => {
      const raw = values[index];
      if (raw === null || raw === undefined) return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      result[id] = n;
    });
    return result;
  }

  private async resolveHudMode(): Promise<"horizontal" | "vertical"> {
    let value: string | undefined;
    try {
      const { settings_by_pk } = await this.hasura.query({
        settings_by_pk: {
          __args: { name: "default_hud_mode" },
          value: true,
        },
      });
      value = settings_by_pk?.value ?? undefined;
    } catch (error) {
      this.logger.warn(
        `failed to read default_hud_mode setting: ${(error as Error)?.message ?? error}`,
      );
    }
    const candidate = value || process.env.HUD_MODE || "horizontal";
    if (candidate === "vertical") return "vertical";
    if (candidate === "horizontal" || candidate === "default")
      return "horizontal";
    this.logger.warn(
      `default_hud_mode="${candidate}" is not one of horizontal|vertical — falling back to "horizontal"`,
    );
    return "horizontal";
  }

  private async readSetting(name: string): Promise<string | undefined> {
    try {
      const { settings_by_pk } = await this.hasura.query({
        settings_by_pk: {
          __args: { name },
          value: true,
        },
      });
      return settings_by_pk?.value ?? undefined;
    } catch (error) {
      this.logger.warn(
        `failed to read ${name} setting: ${(error as Error)?.message ?? error}`,
      );
      return undefined;
    }
  }

  private async resolveLiveVideoCodec(): Promise<"h265" | "h264"> {
    const value =
      (await this.readSetting("live_video_codec")) ||
      process.env.LIVE_VIDEO_CODEC ||
      "h265";
    return value === "h264" ? "h264" : "h265";
  }

  private async resolveClipVideoCodec(): Promise<"h265" | "h264"> {
    const value =
      (await this.readSetting("clip_video_codec")) ||
      process.env.CLIP_VIDEO_CODEC ||
      "h265";
    return value === "h264" ? "h264" : "h265";
  }

  private async resolveClipBakeBranding(): Promise<"0" | "1"> {
    const value =
      (await this.readSetting("clip_bake_branding")) ??
      process.env.CLIP_BAKE_BRANDING ??
      "1";
    return value === "false" || value === "0" ? "0" : "1";
  }

  public async resolveClipFps(): Promise<30 | 60> {
    const value =
      (await this.readSetting("clip_fps")) ?? process.env.CLIP_FPS ?? "60";
    return value === "30" ? 30 : 60;
  }

  public async resolveClipResolution(): Promise<"720p" | "1080p"> {
    const value =
      (await this.readSetting("clip_resolution")) ??
      process.env.CLIP_RESOLUTION ??
      "1080p";
    return value === "720p" ? "720p" : "1080p";
  }

  public static GetLiveJobId(matchId: string) {
    return `gs-live-${matchId}`;
  }

  public static GetLiveServiceName(matchId: string) {
    return `gs-live-${matchId}`;
  }

  private async resolveLiveServiceName(matchId: string): Promise<string> {
    const { match_streams } = await this.hasura.query({
      match_streams: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_game_streamer: { _eq: true },
          },
          limit: 1,
        },
        k8s_service_name: true,
      },
    });
    const saved = (
      match_streams?.[0] as { k8s_service_name?: string | null } | undefined
    )?.k8s_service_name;
    return saved || GameStreamerService.GetLiveServiceName(matchId);
  }

  private async getSpecServerUrl(matchId: string, action: string) {
    const svc = await this.resolveLiveServiceName(matchId);
    return `http://${svc}.${this.namespace}.svc.cluster.local:1350/spec/${action}`;
  }

  // Wire `progress` arrives as a string from the bash reporter; coerce
  // and clamp to numeric(5,2) in 0..100, null otherwise.
  private parseProgress(raw: unknown): number | null {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return null;
    const clamped = Math.max(0, Math.min(100, n));
    return Math.round(clamped * 100) / 100;
  }

  private parseProgressStage(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 64);
  }

  // Builds the next status_history. Status change → append. Same status
  // with progress → mutate the last entry in place so download ticks
  // don't blow the cap-50.
  private nextStatusHistory(
    rawPrevious: unknown,
    currentStatus: unknown,
    newStatus: string,
    progress: number | null,
    progress_stage: string | null,
  ): unknown[] {
    const previous = Array.isArray(rawPrevious)
      ? (rawPrevious as unknown[])
      : [];
    const entry: Record<string, unknown> = {
      status: newStatus,
      at: new Date().toISOString(),
    };
    if (progress !== null) entry.progress = progress;
    if (progress_stage !== null) entry.progress_stage = progress_stage;

    if (currentStatus !== newStatus || previous.length === 0) {
      return [...previous, entry].slice(-STATUS_HISTORY_CAP);
    }
    return [...previous.slice(0, -1), entry];
  }

  private async callSpec(
    matchId: string,
    action:
      | "click"
      | "jump"
      | "player"
      | "slot"
      | "autodirector"
      | "hud"
      | "hud-mode"
      | "hud-reload"
      | "hud-sides"
      | "xray"
      | "scoreboard"
      | "reconnect"
      | "skip-shaders",
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    const url = await this.getSpecServerUrl(matchId, action);
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
    const svc = await this.resolveLiveServiceName(matchId);
    const url = `http://${svc}.${this.namespace}.svc.cluster.local:1350/demo/state`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    } catch {
      return { gsi: null };
    }
    if (!res.ok) {
      return { gsi: null };
    }
    const body = (await res.json().catch(() => ({}))) as { gsi?: any };
    return { gsi: body?.gsi ?? null };
  }

  public async setLiveHudMode(
    matchId: string,
    mode: "default" | "horizontal" | "vertical",
  ) {
    return this.callSpec(matchId, "hud-mode", { mode });
  }

  public async refreshLiveHud(matchId: string) {
    return this.callSpec(matchId, "hud-reload", {});
  }

  public async specHud(matchId: string, visible: boolean) {
    return this.callSpec(matchId, "hud", { visible });
  }

  public async specHudSides(matchId: string) {
    return this.callSpec(matchId, "hud-sides", {});
  }

  public async specXray(matchId: string, enabled: boolean) {
    return this.callSpec(matchId, "xray", { enabled });
  }

  public async specScoreboard(matchId: string, show: boolean) {
    return this.callSpec(matchId, "scoreboard", { show });
  }

  public async reconnectLive(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        status: true,
        server: {
          connected: true,
          enabled: true,
        },
      },
    });
    if (!match) {
      throw new Error(`match ${matchId} not found`);
    }
    if (match.status !== "Live") {
      throw new Error(
        `match is ${match.status} — can only reconnect to a Live match`,
      );
    }
    if (!match.server) {
      throw new Error("no server assigned for match");
    }
    if (match.server.enabled === false) {
      throw new Error("the assigned server is disabled");
    }
    if (match.server.connected !== true) {
      throw new Error(
        "the assigned server is offline — wait for it to come online before reconnecting",
      );
    }
    return this.callSpec(matchId, "reconnect");
  }

  // Operator "Skip shaders": signal the booting pod to launch cs2 now.
  // Unlike reconnectLive, no match-status gate (runs during boot).
  public async skipShaders(matchId: string) {
    return this.callSpec(matchId, "skip-shaders");
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
      demoId: string;
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
          where: { id: { _eq: options.demoId } },
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

    const streamUrl = `${this.appConfig.gameStreamDomain}/${matchId}/`;

    const bootIso = new Date().toISOString();
    const { insert_match_demo_sessions_one } = await this.hasura.mutation({
      insert_match_demo_sessions_one: {
        __args: {
          object: {
            match_id: matchId,
            match_map_id: matchMapId,
            match_map_demo_id: options.demoId,
            watcher_steam_id: userSteamId,
            k8s_job_name: "pending",
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

    let claim: GpuClaim;
    try {
      claim = await this.claimGpuForDemoSession(sessionId);
    } catch (error) {
      await this.stopDemoSessionById(sessionId, jobName);
      throw error;
    }
    const { nodeId, steamAccount } = claim;

    await this.deleteJob(jobName);

    const env: V1EnvVar[] = [
      { name: "MATCH_MAP_ID", value: matchMapId },
      { name: "DEMO_URL", value: options.presignedDemoUrl },
      { name: "DEMO_FILE_NAME", value: options.demoFile },
      { name: "DEMO_SESSION_ID", value: sessionId },
      { name: "HUD_MODE", value: await this.resolveHudMode() },
      { name: "CLIP_VIDEO_CODEC", value: await this.resolveClipVideoCodec() },
      {
        name: "CLIP_BAKE_BRANDING",
        value: await this.resolveClipBakeBranding(),
      },
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

    env.push(...(await this.buildNodeCs2OptionsEnv(nodeId)));

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    this.logger.log(
      `[demo ${sessionId}] starting on node ${nodeId} (job=${jobName})`,
    );

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJobSpec(
        jobName,
        matchId,
        "demo",
        nodeId,
        env,
        { "session-id": sessionId },
        steamAccount,
      ),
    });

    await this.createDemoService(sessionId);

    return {
      streamUrl,
      sessionId,
      matchId,
    };
  }

  /**
   * DEV ONLY — attach the demo player to the standing gs-demo-dev pod instead of
   * booting a Job. Derives the ids from that pod (session-id label + MATCH_MAP_ID
   * / MATCH_ID env) so the web can use a constant /demo/dev URL, registers a
   * match_demo_sessions row + Service selecting it, and returns the resolved ids.
   * Gated: production has no dev=true pod, so this throws. Reaper-safe.
   */
  public async attachDemoSession(userSteamId: string): Promise<{
    streamUrl: string;
    sessionId: string;
    matchId: string;
    matchMapId: string;
  }> {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);

    const pods = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: "app=game-streamer,role=demo,dev=true",
    });
    const pod = (pods.items ?? []).find(
      (p) =>
        (p.status?.phase ?? "") === "Running" &&
        !!p.metadata?.labels?.["session-id"],
    );
    if (!pod) {
      throw new Error(
        "no standing dev demo pod found — start the gs-demo-dev pod " +
          "(a Running pod labelled dev=true with a session-id) first",
      );
    }
    const sessionId = pod.metadata!.labels!["session-id"]!;
    const env = pod.spec?.containers?.[0]?.env ?? [];
    const envVal = (name: string) =>
      env.find((e) => e.name === name)?.value ?? undefined;
    const matchMapId = envVal("MATCH_MAP_ID");
    const matchId = envVal("MATCH_ID") ?? pod.metadata?.labels?.["match-id"];
    if (!matchMapId || !matchId) {
      throw new Error(
        `dev demo pod ${pod.metadata?.name} is missing MATCH_MAP_ID/MATCH_ID`,
      );
    }

    // Resolve the demo for this map — match_map_demo_id is a FK on the row.
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: { where: { match_map_id: { _eq: matchMapId } }, limit: 1 },
        id: true,
      },
    });
    const demoId = match_map_demos?.[0]?.id;
    if (!demoId) {
      throw new Error(`no demo row for match_map ${matchMapId}`);
    }

    // A stale session for this (user, map) under a different id would trip the
    // per-user-per-map unique constraint — clear it before we upsert ours.
    const existing = await this.findDemoSession(matchMapId, userSteamId);
    if (existing && existing.id !== sessionId) {
      await this.stopDemoSessionById(existing.id, existing.k8s_job_name);
    }

    const streamUrl = `${this.appConfig.gameStreamDomain}/${matchId}/`;
    const nowIso = new Date().toISOString();

    // Upsert keyed on the pod's session id. status=playing (the pod is already
    // mid-playback and reports 'playing' only once); the page gates controls on
    // it, so seed it directly.
    await this.hasura.mutation({
      insert_match_demo_sessions_one: {
        __args: {
          object: {
            id: sessionId,
            match_id: matchId,
            match_map_id: matchMapId,
            match_map_demo_id: demoId,
            watcher_steam_id: userSteamId,
            k8s_job_name: "dev-attach",
            stream_url: streamUrl,
            status: "playing",
            status_history: [{ status: "playing", at: nowIso }],
            last_activity_at: nowIso,
          },
          on_conflict: {
            constraint: "match_demo_sessions_pkey" as any,
            update_columns: [
              "match_id",
              "match_map_id",
              "match_map_demo_id",
              "watcher_steam_id",
              "k8s_job_name",
              "stream_url",
              "status",
              "last_activity_at",
            ] as any,
          },
        },
        id: true,
      },
    });

    // Service selects the dev pod by its session-id label (same shape the
    // Job-boot path uses) so getDemoSpecUrl/demoControl resolve to it.
    await this.createDemoService(sessionId);

    this.logger.log(
      `[demo ${sessionId}] DEV attach -> pod ${pod.metadata?.name} (map ${matchMapId})`,
    );

    return { streamUrl, sessionId, matchId, matchMapId };
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

  public async dispatchClipRenderToPod(
    sessionId: string,
    payload: {
      job_id: string;
      token: string;
      api_base: string;
      segments: Array<{
        start_tick: number;
        end_tick: number;
        kill_tick?: number;
        pov_steam_id?: string;
      }>;
      output_dims: string;
      output_fps: number;
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

  public async reportDemoStatus(
    sessionId: string,
    body: GameStreamerStatusDto,
  ) {
    const { match_demo_sessions_by_pk: current } = await this.hasura.query({
      match_demo_sessions_by_pk: {
        __args: { id: sessionId },
        status: true,
        status_history: true,
      },
    });

    if (!current) {
      this.logger.warn(
        `[demo ${sessionId}] reportDemoStatus: row missing — was the session torn down?`,
      );
      return;
    }

    const progress = this.parseProgress(body.progress);
    const progress_stage = this.parseProgressStage(body.progress_stage);
    const nextHistory = this.nextStatusHistory(
      current.status_history,
      current.status,
      body.status,
      progress,
      progress_stage,
    );

    const statusChanged = current.status !== body.status;
    const set: Record<string, unknown> = {
      status: body.status,
      error_message: body.error ?? null,
      status_history: nextHistory,
    };
    if (statusChanged) {
      set.last_status_at = "now()";
    }

    await this.hasura.mutation({
      update_match_demo_sessions_by_pk: {
        __args: {
          pk_columns: { id: sessionId },
          _set: set,
        },
        id: true,
      },
    });

    const progressNote =
      progress !== null
        ? ` progress=${progress}${progress_stage ? ` stage=${progress_stage}` : ""}`
        : "";
    this.logger.log(
      `[demo ${sessionId}] status=${body.status}${progressNote}${body.error ? ` err=${body.error}` : ""}`,
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
        ports: [{ name: "spec", port: 1350, targetPort: "spec" }],
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

  public async startLive(
    matchId: string,
    mode: "live" | "tv",
  ): Promise<{ status: "booting" | "pending" }> {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        id: true,
        status: true,
        password: true,
        server: {
          host: true,
          port: true,
          tv_port: true,
          connected: true,
          enabled: true,
          server_region: {
            is_lan: true,
          },
          game_server_node: {
            node_ip: true,
          },
        },
      },
    });

    if (!match) {
      throw new Error(`match ${matchId} not found`);
    }

    if (match.status !== "Live") {
      throw new Error(
        `match is ${match.status} — wait for it to go Live before starting a stream`,
      );
    }

    if (!match.server) {
      throw new Error("no server assigned for match");
    }

    if (match.server.enabled === false) {
      throw new Error("the assigned server is disabled");
    }

    if (match.server.connected !== true) {
      throw new Error(
        "the assigned server is offline — wait for it to come online before starting the stream",
      );
    }

    const usePlaycast = await this.readUsePlaycast();

    const claim = await this.claimGpuForLive(matchId, mode);
    if (claim === null) {
      this.logger.log(
        `[${matchId}] no GPU free — match_streams row inserted as pending`,
      );
      return { status: "pending" };
    }
    const { nodeId, steamAccount } = claim;

    const connectEnv = await this.buildConnectEnv(
      matchId,
      match.server,
      match.password,
      usePlaycast,
      mode,
    );

    const reporterEnv: V1EnvVar[] = [
      { name: "MATCH_PASSWORD", value: match.password },
      { name: "HUD_MODE", value: await this.resolveHudMode() },
      { name: "LIVE_VIDEO_CODEC", value: await this.resolveLiveVideoCodec() },
      { name: "CLIP_VIDEO_CODEC", value: await this.resolveClipVideoCodec() },
      {
        name: "CLIP_BAKE_BRANDING",
        value: await this.resolveClipBakeBranding(),
      },
      // (shader pre-caching is pod-default on; skipped per-match at runtime)
    ];

    const nodeCs2Env = await this.buildNodeCs2OptionsEnv(nodeId);

    const jobName = GameStreamerService.GetLiveJobId(matchId);

    await this.deleteJob(jobName);

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    const connectTarget =
      connectEnv.find((e) => e.name === "CONNECT_ADDR")?.value ??
      connectEnv.find((e) => e.name === "CONNECT_TV_ADDR")?.value ??
      connectEnv.find((e) => e.name === "PLAYCAST_URL")?.value;
    this.logger.log(
      `[${matchId}] starting ${mode} stream on node ${nodeId} -> ${connectTarget}`,
    );

    try {
      await batch.createNamespacedJob({
        namespace: this.namespace,
        body: this.buildJobSpec(
          jobName,
          matchId,
          "live",
          nodeId,
          [...connectEnv, ...reporterEnv, ...nodeCs2Env],
          {},
          steamAccount,
        ),
      });
    } catch (error) {
      await this.unregisterStreamRow(matchId);
      throw error;
    }

    await this.createLiveService(matchId);

    return { status: "booting" };
  }

  public async promotePendingLiveStreams(): Promise<{
    promoted: string[];
    stillPending: number;
  }> {
    const { match_streams } = await this.hasura.query({
      match_streams: {
        __args: {
          where: {
            is_game_streamer: { _eq: true },
            status: { _eq: "pending" },
          },
          order_by: [{ last_status_at: "asc" }],
        },
        match_id: true,
        mode: true,
      },
    });
    const rows =
      (match_streams as Array<{
        match_id: string;
        mode: string | null;
      }>) ?? [];
    const promoted: string[] = [];
    for (const row of rows) {
      const matchId = String(row.match_id);
      const mode = row.mode === "tv" ? "tv" : "live";
      try {
        const result = await this.startLive(matchId, mode);
        if (result.status === "booting") {
          promoted.push(matchId);
        } else {
          break;
        }
      } catch (error) {
        this.logger.warn(
          `[promote-pending ${matchId}] startLive failed: ${(error as Error)?.message}`,
        );
      }
    }
    const stillPending = rows.length - promoted.length;
    if (promoted.length > 0) {
      this.logger.log(
        `[promote-pending] promoted ${promoted.length} match(es), ${stillPending} still pending`,
      );
    }
    return { promoted, stillPending };
  }

  public async stopGpuSession(nodeId: string): Promise<{
    stopped_live: number;
    stopped_demo_sessions: number;
    cancelled_render_jobs: number;
  }> {
    let stoppedLive = 0;
    let stoppedDemoSessions = 0;
    let cancelledRenderJobs = 0;

    const { match_streams } = await this.hasura.query({
      match_streams: {
        __args: {
          where: {
            is_game_streamer: { _eq: true },
            game_server_node_id: { _eq: nodeId },
          },
        },
        match_id: true,
      },
    });
    for (const stream of (match_streams as Array<{ match_id: string }>) ?? []) {
      try {
        await this.stopLive(stream.match_id);
        stoppedLive++;
      } catch (error) {
        this.logger.error(
          `[stopGpuSession ${nodeId}] stopLive(${stream.match_id}) failed: ${(error as Error)?.message}`,
        );
      }
    }

    const { match_demo_sessions } = await this.hasura.query({
      match_demo_sessions: {
        __args: {
          where: { game_server_node_id: { _eq: nodeId } },
        },
        id: true,
        k8s_job_name: true,
      },
    });
    for (const session of (match_demo_sessions as Array<{
      id: string;
      k8s_job_name: string;
    }>) ?? []) {
      try {
        await this.stopDemoSessionById(session.id, session.k8s_job_name);
        stoppedDemoSessions++;
      } catch (error) {
        this.logger.error(
          `[stopGpuSession ${nodeId}] stopDemoSessionById(${session.id}) failed: ${(error as Error)?.message}`,
        );
      }
    }

    const { clip_render_jobs } = await this.hasura.query({
      clip_render_jobs: {
        __args: {
          where: {
            game_server_node_id: { _eq: nodeId },
            status: { _in: ["queued", "rendering", "uploading"] },
          },
          distinct_on: ["match_map_id", "match_map_demo_id"],
        },
        match_map_id: true,
        match_map_demo_id: true,
      },
    });
    for (const job of (clip_render_jobs as Array<{
      match_map_id: string;
      match_map_demo_id: string;
    }>) ?? []) {
      try {
        await this.killBatchHighlightsPod(
          job.match_map_id,
          job.match_map_demo_id,
        );
      } catch (error) {
        this.logger.error(
          `[stopGpuSession ${nodeId}] killBatchHighlightsPod(${job.match_map_id}, ${job.match_map_demo_id}) failed: ${(error as Error)?.message}`,
        );
      }
    }
    if ((clip_render_jobs ?? []).length > 0) {
      const { update_clip_render_jobs } = await this.hasura.mutation({
        update_clip_render_jobs: {
          __args: {
            where: {
              game_server_node_id: { _eq: nodeId },
              status: { _in: ["queued", "rendering", "uploading"] },
            },
            _set: {
              status: "cancelled",
              error_message: "cancelled by operator (gpu node)",
              last_status_at: "now()",
              game_server_node_id: null,
              steam_account_id: null,
            },
          },
          affected_rows: true,
        },
      });
      cancelledRenderJobs =
        (update_clip_render_jobs?.affected_rows as number) ?? 0;
    }

    this.logger.log(
      `[stopGpuSession ${nodeId}] stopped live=${stoppedLive} demo=${stoppedDemoSessions} render_jobs=${cancelledRenderJobs}`,
    );

    return {
      stopped_live: stoppedLive,
      stopped_demo_sessions: stoppedDemoSessions,
      cancelled_render_jobs: cancelledRenderJobs,
    };
  }

  public async stopLive(matchId: string) {
    // Job name == Service name by construction.
    const jobName = await this.resolveLiveServiceName(matchId);
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

  public async switchLive(
    fromMatchId: string,
    toMatchId: string,
    mode: "live" | "tv",
  ) {
    if (fromMatchId === toMatchId) {
      throw new Error("from and to match are the same");
    }
    if (mode !== "live" && mode !== "tv") {
      throw new Error("invalid mode");
    }

    const { match_streams: fromRows } = await this.hasura.query({
      match_streams: {
        __args: {
          where: {
            match_id: { _eq: fromMatchId },
            is_game_streamer: { _eq: true },
          },
          limit: 1,
        },
        id: true,
        is_live: true,
        autodirector: true,
        mode: true,
        k8s_service_name: true,
      },
    });
    const from = fromRows?.[0] as
      | {
          id: string;
          is_live: boolean;
          autodirector: boolean | null;
          mode: string;
          k8s_service_name: string | null;
        }
      | undefined;
    if (!from) {
      throw new Error(`no active game-streamer for match ${fromMatchId}`);
    }
    if (!from.is_live) {
      throw new Error(
        "source stream is not live yet — wait for boot to finish before switching",
      );
    }

    const { match_streams: destRows } = await this.hasura.query({
      match_streams: {
        __args: {
          where: {
            match_id: { _eq: toMatchId },
            is_game_streamer: { _eq: true },
          },
          limit: 1,
        },
        id: true,
      },
    });
    if ((destRows ?? []).length > 0) {
      throw new Error(`match ${toMatchId} already has an active stream`);
    }

    const { matches_by_pk: toMatch } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: toMatchId },
        id: true,
        status: true,
        password: true,
        server: {
          host: true,
          port: true,
          tv_port: true,
          connected: true,
          enabled: true,
          server_region: {
            is_lan: true,
          },
          game_server_node: {
            node_ip: true,
          },
        },
      },
    });
    if (!toMatch) {
      throw new Error(`match ${toMatchId} not found`);
    }
    if (toMatch.status !== "Live") {
      throw new Error(
        `destination match is ${toMatch.status} — can only switch to a Live match`,
      );
    }
    if (!toMatch.server) {
      throw new Error(`match ${toMatchId} has no server assigned`);
    }
    if (toMatch.server.enabled === false) {
      throw new Error(`destination match's server is disabled`);
    }
    if (toMatch.server.connected !== true) {
      throw new Error(
        `destination match's server is offline — wait for it to come online before switching`,
      );
    }

    const usePlaycast = await this.readUsePlaycast();
    const connectEnv = await this.buildConnectEnv(
      toMatchId,
      toMatch.server,
      toMatch.password,
      usePlaycast,
      mode,
    );

    const envMap: Record<string, string> = {};
    for (const e of connectEnv) {
      if (e.name && typeof e.value === "string") envMap[e.name] = e.value;
    }
    const switchBody: Record<string, unknown> = {
      matchId: toMatchId,
      oldMatchId: fromMatchId,
      mode,
      matchPassword: toMatch.password,
    };
    if (envMap.PLAYCAST_URL) {
      switchBody.playcastUrl = envMap.PLAYCAST_URL;
    } else if (envMap.CONNECT_TV_ADDR) {
      switchBody.connect = {
        addr: envMap.CONNECT_TV_ADDR,
        password: envMap.CONNECT_TV_PASSWORD ?? "",
      };
    } else if (envMap.CONNECT_ADDR) {
      switchBody.connect = {
        addr: envMap.CONNECT_ADDR,
        password: envMap.CONNECT_PASSWORD ?? "",
      };
    } else {
      throw new Error("could not derive connect details for destination match");
    }

    // Resolve URL before mutating the row (resolveLiveServiceName keys off
    // the row's current match_id), then repoint the row, then call spec-server.
    // Revert the row on spec failure so the pod and row don't drift.
    const url = await this.getSpecServerUrl(fromMatchId, "switch-match");

    await this.hasura.mutation({
      update_match_streams: {
        __args: {
          where: { id: { _eq: from.id } },
          _set: {
            match_id: toMatchId,
            mode,
            autodirector: true,
          },
        },
        affected_rows: true,
      },
    });

    const revert = async (reason: string) => {
      try {
        await this.hasura.mutation({
          update_match_streams: {
            __args: {
              where: { id: { _eq: from.id } },
              _set: {
                match_id: fromMatchId,
                mode: from.mode,
                autodirector: from.autodirector ?? false,
              },
            },
            affected_rows: true,
          },
        });
      } catch (revertError) {
        this.logger.error(
          `[switchLive] ${fromMatchId} -> ${toMatchId} revert FAILED after ${reason}: ` +
            `${(revertError as Error)?.message}. ` +
            `match_streams.id=${from.id} stranded on match_id=${toMatchId}.`,
        );
      }
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(switchBody),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      await revert("spec-server unreachable");
      throw new Error(
        `spec-server switch-match unreachable: ${(error as Error)?.message}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await revert(`spec-server returned ${res.status}`);
      throw new Error(
        `spec-server switch-match -> ${res.status}: ${text.slice(0, 200)}`,
      );
    }

    this.logger.log(
      `[switchLive] ${fromMatchId} -> ${toMatchId} (mode=${mode}) repointed`,
    );
  }

  public static GetBatchHighlightsJobName(
    matchMapId: string,
    matchMapDemoId: string,
  ) {
    const mapPart = matchMapId.replace(/-/g, "").slice(0, 8);
    const demoPart = matchMapDemoId.replace(/-/g, "").slice(0, 8);
    return `gs-batch-${mapPart}-${demoPart}`;
  }

  public async getBatchHighlightsPodState(
    matchMapId: string,
    matchMapDemoId: string,
  ): Promise<"running" | "succeeded" | "failed" | "absent"> {
    const jobName = GameStreamerService.GetBatchHighlightsJobName(
      matchMapId,
      matchMapDemoId,
    );
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
    return "running";
  }

  public async getBatchPodFailureReason(
    matchMapId: string,
    matchMapDemoId: string,
  ): Promise<string | null> {
    const jobName = GameStreamerService.GetBatchHighlightsJobName(
      matchMapId,
      matchMapDemoId,
    );
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
    const sorted = [...(pods.items ?? [])].sort((a, b) => {
      const ta = new Date(a.metadata?.creationTimestamp ?? 0).getTime();
      const tb = new Date(b.metadata?.creationTimestamp ?? 0).getTime();
      return tb - ta;
    });
    const pod = sorted[0];
    if (!pod?.metadata?.name) return null;

    const term =
      pod.status?.containerStatuses?.[0]?.lastState?.terminated ??
      pod.status?.containerStatuses?.[0]?.state?.terminated;
    const reason = term?.reason ?? null;
    const exitCode = term?.exitCode ?? null;

    let logTail: string | null = null;
    try {
      const logs = await core.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.namespace,
        tailLines: 200,
      });
      const lines = String(logs ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length > 0) {
        // Prefer ERROR:/WARN: lines from die()/warn() over routine noise.
        const flagged = lines.filter((l) =>
          /^\[[^\]]+\]\s+(ERROR|WARN):/i.test(l),
        );
        const picked = flagged.length > 0 ? flagged.slice(-5) : lines.slice(-5);
        logTail = picked.join(" | ");
      }
    } catch {}

    const parts: string[] = [];
    if (reason) parts.push(reason);
    if (exitCode != null) parts.push(`exit=${exitCode}`);
    if (logTail) parts.push(logTail);
    if (parts.length === 0) return null;
    return parts.join(" — ").slice(0, 500);
  }

  public async killBatchHighlightsPod(
    matchMapId: string,
    matchMapDemoId: string,
  ): Promise<void> {
    const jobName = GameStreamerService.GetBatchHighlightsJobName(
      matchMapId,
      matchMapDemoId,
    );
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

  public async dispatchBatchHighlights(
    matchMapId: string,
    jobs: Array<{ job_id: string; session_token: string; spec: unknown }>,
    matchMapDemoId: string,
  ): Promise<void> {
    if (jobs.length === 0) return;

    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: { id: { _eq: matchMapDemoId } },
          limit: 1,
        },
        id: true,
        match_id: true,
        match_map_id: true,
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
        `cannot dispatch batch highlights: no demo file for demo ${matchMapDemoId}`,
      );
    }
    if (String(demo.match_map_id) !== matchMapId) {
      throw new Error(
        `demo ${matchMapDemoId} does not belong to match_map ${matchMapId} (got ${demo.match_map_id})`,
      );
    }
    const matchId = String(demo.match_id);
    const resolvedDemoId = String(demo.id);

    const demoFile = demo.file as string;
    const presignedDemoUrl = await this.demoMetadata.resolveDemoFetchUrl(
      demoFile,
      60 * 60,
    );

    const { nodeId, steamAccount } = await this.claimGpuForBatchHighlights(
      matchMapId,
      resolvedDemoId,
    );
    const jobName = GameStreamerService.GetBatchHighlightsJobName(
      matchMapId,
      resolvedDemoId,
    );

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    const env: V1EnvVar[] = [
      { name: "MATCH_ID", value: matchId },
      { name: "MATCH_MAP_ID", value: matchMapId },
      { name: "MATCH_MAP_DEMO_ID", value: resolvedDemoId },
      { name: "DEMO_URL", value: presignedDemoUrl },
      { name: "DEMO_FILE_NAME", value: demo.file as string },
      { name: "STATUS_API_BASE", value: resolveInClusterApiBase() },
      { name: "HUD_MODE", value: await this.resolveHudMode() },
      { name: "CLIP_BATCH_MODE", value: "1" },
      { name: "AUTODIRECTOR", value: "0" },
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
    env.push({
      name: "CLIP_VIDEO_CODEC",
      value: await this.resolveClipVideoCodec(),
    });
    env.push({
      name: "CLIP_BAKE_BRANDING",
      value: await this.resolveClipBakeBranding(),
    });
    env.push(...(await this.buildNodeCs2OptionsEnv(nodeId)));

    this.logger.log(
      `[batch-highlights ${matchMapId}] dispatching ${jobs.length} job(s) to pod ${jobName} on node ${nodeId}`,
    );

    const existing = await this.getBatchHighlightsPodState(
      matchMapId,
      resolvedDemoId,
    );
    if (existing === "running") {
      throw new Error(
        `batch-highlights pod ${jobName} is already running for match_map ${matchMapId} demo ${resolvedDemoId} — wait for it to finish or kill it before re-dispatching`,
      );
    }
    if (existing !== "absent") {
      this.logger.warn(
        `[batch-highlights ${matchMapId} demo ${resolvedDemoId}] reaping stale ${existing} Job ${jobName} before re-dispatch`,
      );
      await this.killBatchHighlightsPod(matchMapId, resolvedDemoId);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (
          (await this.getBatchHighlightsPodState(
            matchMapId,
            resolvedDemoId,
          )) === "absent"
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    try {
      await batch.createNamespacedJob({
        namespace: this.namespace,
        body: this.buildJobSpec(
          jobName,
          matchId,
          "batch-highlights",
          nodeId,
          env,
          {
            "match-map-id": matchMapId,
            "match-map-demo-id": resolvedDemoId,
          },
          steamAccount,
        ),
      });
    } catch (error) {
      await this.postgres.query(
        `UPDATE clip_render_jobs
            SET game_server_node_id = NULL,
                steam_account_id = NULL
          WHERE match_map_id = $1
            AND match_map_demo_id = $2
            AND status IN ('queued','rendering','uploading')`,
        [matchMapId, resolvedDemoId],
      );
      throw error;
    }
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

  private async claimSteamAccountForRow(
    client: { query: (sql: string, params?: unknown[]) => Promise<any> },
    tableName: "match_streams" | "match_demo_sessions" | "clip_render_jobs",
    nodeId: string,
    rowFilterSql: string,
    rowFilterParams: unknown[],
  ): Promise<ClaimedSteamAccount> {
    const nodeParamIndex = rowFilterParams.length + 1;
    const result = await client.query(
      `WITH chosen AS (SELECT claim_free_steam_account($${nodeParamIndex}) AS id),
            applied AS (
              UPDATE ${tableName}
                 SET steam_account_id = chosen.id
                FROM chosen
               WHERE ${rowFilterSql}
                 AND chosen.id IS NOT NULL
              RETURNING ${tableName}.steam_account_id
            )
       SELECT sa.id, sa.username, sa.password
         FROM applied
         JOIN steam_accounts sa ON sa.id = applied.steam_account_id`,
      [...rowFilterParams, nodeId],
    );
    const row = result.rows[0];
    if (!row?.id) {
      throw new NoSteamAccountAvailableError();
    }
    return {
      id: String(row.id),
      username: String(row.username),
      password: String(row.password),
    };
  }

  private async claimGpuForLive(
    matchId: string,
    mode: "live" | "tv",
  ): Promise<GpuClaim | null> {
    const link = `${this.appConfig.gameStreamDomain}/${matchId}/`;
    const nowIso = new Date().toISOString();
    const bootingHistory = JSON.stringify([{ status: "booting", at: nowIso }]);
    const pendingHistory = JSON.stringify([{ status: "pending", at: nowIso }]);

    return this.postgres.transaction(async (client) => {
      await client.query(
        `DELETE FROM match_streams
          WHERE match_id = $1 AND is_game_streamer = true`,
        [matchId],
      );

      const serviceName = GameStreamerService.GetLiveServiceName(matchId);
      const result = await client.query(
        `WITH chosen AS (SELECT claim_free_gpu_node() AS id)
         INSERT INTO match_streams
           (match_id, title, link, priority, is_game_streamer, is_live,
            mode, status, status_history, last_status_at,
            game_server_node_id, k8s_service_name)
         SELECT $1, $2, $3, 0, true, false, $4, 'booting', $5::jsonb, now(),
                chosen.id, $6
           FROM chosen
          WHERE chosen.id IS NOT NULL
         RETURNING id, game_server_node_id`,
        [matchId, GAME_STREAMER_TITLE, link, mode, bootingHistory, serviceName],
      );

      const streamRow = result.rows[0];
      const nodeId = streamRow?.game_server_node_id as string | undefined;
      if (nodeId) {
        const steamAccount = await this.claimSteamAccountForRow(
          client,
          "match_streams",
          nodeId,
          "match_streams.id = $1 AND match_streams.steam_account_id IS NULL",
          [streamRow.id],
        );
        return { nodeId, steamAccount };
      }

      const { rows: gpuRows } = await client.query(
        `SELECT count(*)::int AS n
           FROM game_server_nodes
          WHERE gpu = true AND enabled = true AND gpu_streaming_enabled = true AND status IN ('Online', 'NotAcceptingNewMatches')`,
      );
      const registeredGpus = (gpuRows[0]?.n as number | undefined) ?? 0;
      if (registeredGpus === 0) {
        throw new NoGpuAvailableError();
      }

      await client.query(
        `INSERT INTO match_streams
           (match_id, title, link, priority, is_game_streamer, is_live,
            mode, status, status_history, last_status_at, k8s_service_name)
         VALUES ($1, $2, $3, 0, true, false,
                 $4, 'pending', $5::jsonb, now(), $6)`,
        [matchId, GAME_STREAMER_TITLE, link, mode, pendingHistory, serviceName],
      );
      return null;
    });
  }

  private async claimGpuForDemoSession(sessionId: string): Promise<GpuClaim> {
    return this.postgres.transaction(async (client) => {
      const result = await client.query(
        `WITH chosen AS (SELECT claim_free_gpu_node_for_demo() AS id)
         UPDATE match_demo_sessions
            SET game_server_node_id = chosen.id
           FROM chosen
          WHERE match_demo_sessions.id = $1
            AND match_demo_sessions.game_server_node_id IS NULL
            AND chosen.id IS NOT NULL
         RETURNING match_demo_sessions.game_server_node_id`,
        [sessionId],
      );

      const nodeId = result.rows[0]?.game_server_node_id as string | undefined;
      if (!nodeId) {
        throw new NoGpuAvailableError();
      }
      const steamAccount = await this.claimSteamAccountForRow(
        client,
        "match_demo_sessions",
        nodeId,
        "match_demo_sessions.id = $1 AND match_demo_sessions.steam_account_id IS NULL",
        [sessionId],
      );
      return { nodeId, steamAccount };
    });
  }

  private async claimGpuForBatchHighlights(
    matchMapId: string,
    matchMapDemoId: string,
  ): Promise<GpuClaim> {
    return this.postgres.transaction(async (client) => {
      const result = await client.query(
        `WITH chosen AS (SELECT claim_free_gpu_node_for_batch() AS id)
         UPDATE clip_render_jobs
            SET game_server_node_id = chosen.id
           FROM chosen
          WHERE clip_render_jobs.match_map_id = $1
            AND clip_render_jobs.match_map_demo_id = $2
            AND clip_render_jobs.status IN ('queued','rendering','uploading')
            AND clip_render_jobs.game_server_node_id IS NULL
            AND chosen.id IS NOT NULL
         RETURNING clip_render_jobs.game_server_node_id`,
        [matchMapId, matchMapDemoId],
      );

      const nodeId = result.rows[0]?.game_server_node_id as string | undefined;
      if (!nodeId) {
        throw new NoGpuAvailableError();
      }
      const steamAccount = await this.claimSteamAccountForRow(
        client,
        "clip_render_jobs",
        nodeId,
        "clip_render_jobs.match_map_id = $1 AND clip_render_jobs.match_map_demo_id = $2 AND clip_render_jobs.status IN ('queued','rendering','uploading') AND clip_render_jobs.steam_account_id IS NULL",
        [matchMapId, matchMapDemoId],
      );
      return { nodeId, steamAccount };
    });
  }

  private async buildNodeCs2OptionsEnv(nodeId: string): Promise<V1EnvVar[]> {
    const { game_server_nodes_by_pk: node } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: { id: nodeId },
        cs2_video_settings: true,
      },
    });
    const settings =
      (node as { cs2_video_settings?: Record<string, number> } | null)
        ?.cs2_video_settings ?? {};
    const env: V1EnvVar[] = [
      { name: "CS2_VIDEO_SETTINGS", value: JSON.stringify(settings) },
    ];
    // Resolution drives both the Xorg virtual screen and the cs2
    // -width / -height launch args. Default (1920x1080) is implicit
    // streamer-side; we emit CS2_DISPLAY_RES only when the node opted
    // into a non-default size (currently 2560x1440).
    const w = settings["setting.defaultres"];
    const h = settings["setting.defaultresheight"];
    if (typeof w === "number" && typeof h === "number") {
      env.push({ name: "CS2_DISPLAY_RES", value: `${w}x${h}` });
    }
    return env;
  }

  private async buildConnectEnv(
    matchId: string,
    server: {
      host: string;
      port: number;
      tv_port: number | null;
      server_region?: { is_lan?: boolean | null } | null;
      game_server_node?: { node_ip?: string | null } | null;
    },
    matchPassword: string,
    usePlaycast: boolean,
    mode: "live" | "tv",
  ): Promise<V1EnvVar[]> {
    const host =
      server.server_region?.is_lan && server.game_server_node?.node_ip
        ? server.game_server_node.node_ip
        : server.host;

    // tv mode: respect the GOTV/Playcast path so the broadcast carries the
    // configured tv_delay. Playcast (when enabled) wins over the server's
    // tv_port — same precedence as get_match_tv_connection_string().
    if (mode === "tv") {
      if (usePlaycast) {
        return [
          { name: "PLAYCAST_URL", value: `https://tv.5stack.gg/${matchId}` },
          { name: "PLAYCAST_PASSWORD", value: "" },
        ];
      }

      if (!server.tv_port) {
        throw new Error(
          "tv mode requires a server with tv_port or Playcast enabled",
        );
      }

      return [
        {
          name: "CONNECT_TV_ADDR",
          value: `${host}:${server.tv_port}`,
        },
        { name: "CONNECT_TV_PASSWORD", value: matchPassword },
      ];
    }

    // live mode: direct game-port connection. No GOTV delay, available the
    // moment the match goes Live. Playcast does not apply.
    //
    // The dedicated server is started with `+sv_password ${match.password}`
    // (see match-assistant.service.ts), so the streamer pod authenticates
    // with the raw match password — same value, just the game port instead
    // of the TV port. The 5stack CS2 plugin auto-allocates non-roster Steam
    // IDs into a spectator slot (the server is started with extra slots:
    // `max_players_per_lineup * 2 + 3`), so the streamer ends up observing
    // rather than occupying a roster slot.
    return [
      { name: "CONNECT_ADDR", value: `${host}:${server.port}` },
      { name: "CONNECT_PASSWORD", value: matchPassword },
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
        ports: [{ name: "spec", port: 1350, targetPort: "spec" }],
      },
    };

    await core.createNamespacedService({
      namespace: this.namespace,
      body,
    });
  }

  private async deleteLiveService(matchId: string) {
    const serviceName = await this.resolveLiveServiceName(matchId);
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
        status: true,
        status_history: true,
      },
    });
    const row = match_streams?.[0];
    const progress = this.parseProgress(body.progress);
    const progress_stage = this.parseProgressStage(body.progress_stage);
    const nextHistory = this.nextStatusHistory(
      row?.status_history,
      row?.status,
      body.status,
      progress,
      progress_stage,
    );

    const statusChanged = row?.status !== body.status;
    const setClause: Record<string, unknown> = {
      status: body.status,
      stream_url: body.stream_url ?? null,
      error_message: body.error ?? null,
      is_live: body.status === "live",
      status_history: nextHistory,
    };
    if (statusChanged) {
      setClause.last_status_at = "now()";
    }

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
    const progressNote =
      progress !== null
        ? ` progress=${progress}${progress_stage ? ` stage=${progress_stage}` : ""}`
        : "";
    this.logger.log(
      `[${matchId}] reportStatus status=${body.status}${progressNote} updated=${updated}`,
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
              link: `${this.appConfig.gameStreamDomain}/${matchId}/`,
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

  public static GET_BAKE_JOB_NAME(gameServerNodeId: string): string {
    return `shader-bake-${gameServerNodeId.replaceAll(".", "-")}`;
  }

  public async isNodeBusy(gameServerNodeId: string): Promise<boolean> {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);

    const pods = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: "app=game-streamer",
    });

    for (const pod of pods.items) {
      if (pod.spec?.nodeName !== gameServerNodeId) {
        continue;
      }
      if (pod.metadata?.labels?.role === "warm-shaders") {
        continue;
      }
      const phase = pod.status?.phase;
      if (phase === "Running" || phase === "Pending") {
        return true;
      }
    }

    return false;
  }

  public async bakeShaders(gameServerNodeId: string): Promise<void> {
    const { game_server_nodes_by_pk: node } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: { id: gameServerNodeId },
        id: true,
        gpu: true,
        shader_bake_status: true,
      },
    });

    if (!node) {
      throw new Error("Game server node not found");
    }

    if (!node.gpu) {
      throw new Error("Game server node is not a GPU node");
    }

    if (await this.isNodeBusy(gameServerNodeId)) {
      throw new NodeBusyError();
    }

    const jobName = GameStreamerService.GET_BAKE_JOB_NAME(gameServerNodeId);

    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    // Always tear down any prior bake (a failed/finished Job lingers and
    // would otherwise block a fresh start) before launching a new one.
    await this.deleteJob(jobName);
    await this.waitForJobGone(jobName);

    this.logger.log(
      `[bake ${gameServerNodeId}] starting shader bake (job=${jobName})`,
    );

    // Warm the shaders against the node's real video settings (resolution /
    // quality drive the pipeline set) so the cache matches live; without this
    // the bake runs in auto mode and warms the wrong pipelines.
    const bakeEnv = [
      { name: "BAKE_NODE_ID", value: gameServerNodeId },
      ...(await this.buildNodeCs2OptionsEnv(gameServerNodeId)),
    ];

    await batch.createNamespacedJob({
      namespace: this.namespace,
      body: this.buildJobSpec(
        jobName,
        gameServerNodeId,
        "warm-shaders",
        gameServerNodeId,
        bakeEnv,
        { "node-id": gameServerNodeId },
      ),
    });

    await this.setBakeStatus(gameServerNodeId, "Initializing");

    setTimeout(() => {
      void this.monitorBakeShaders(gameServerNodeId, 3);
    }, 5000);
  }

  public async cancelBakeShaders(gameServerNodeId: string): Promise<void> {
    const jobName = GameStreamerService.GET_BAKE_JOB_NAME(gameServerNodeId);
    this.logger.log(`[bake ${gameServerNodeId}] cancelling shader bake`);
    await this.deleteJob(jobName);
    await this.setBakeStatus(gameServerNodeId, null);
  }

  private async waitForJobGone(jobName: string, attempts = 20): Promise<void> {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    for (let i = 0; i < attempts; i++) {
      try {
        await batch.readNamespacedJob({
          name: jobName,
          namespace: this.namespace,
        });
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private async setBakeStatus(
    gameServerNodeId: string,
    status: string | null,
  ): Promise<void> {
    await this.hasura.mutation({
      update_game_server_nodes_by_pk: {
        __args: {
          pk_columns: { id: gameServerNodeId },
          _set: {
            shader_bake_status: status,
            ...(status === null
              ? {
                  shader_bake_progress: null,
                  shader_bake_progress_stage: null,
                }
              : {}),
          },
        },
        id: true,
      },
    });
  }

  // Poll the bake Job for completion and refresh progress from a log
  // snapshot each tick. Completion is driven by Job status (not the log
  // stream lifecycle) so the status/progress stays live through pod launch
  // — the warm container has no logs yet while the init container runs, and
  // a follow stream would otherwise end early and wipe the status.
  public async monitorBakeShaders(
    gameServerNodeId: string,
    attempts = 0,
  ): Promise<void> {
    const jobName = GameStreamerService.GET_BAKE_JOB_NAME(gameServerNodeId);

    let status: Awaited<ReturnType<typeof this.loggingService.getJobStatus>>;
    try {
      status = await this.loggingService.getJobStatus(jobName);
    } catch {
      status = null;
    }

    if (!status) {
      // Right after create the Job may not be visible yet; retry a few
      // times before assuming it's gone.
      if (attempts > 0) {
        setTimeout(() => {
          void this.monitorBakeShaders(gameServerNodeId, attempts - 1);
        }, 5000);
        return;
      }
      await this.setBakeStatus(gameServerNodeId, null);
      return;
    }

    if ((status.succeeded ?? 0) > 0) {
      await this.setBakeStatus(gameServerNodeId, null);
      return;
    }

    if ((status.failed ?? 0) > 0) {
      await this.setBakeStatus(gameServerNodeId, "errored");
      return;
    }

    // progress is posted by the pod (reportBakeStatus); only watch terminal state
    setTimeout(() => {
      void this.monitorBakeShaders(gameServerNodeId, 3);
    }, 5000);
  }

  public async reportBakeStatus(
    gameServerNodeId: string,
    body: GameStreamerStatusDto,
  ): Promise<void> {
    const { game_server_nodes_by_pk: node } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: { id: gameServerNodeId },
        id: true,
        shader_bake_status: true,
      },
    });
    if (!node) {
      this.logger.warn(
        `[bake ${gameServerNodeId}] reportBakeStatus: node missing`,
      );
      return;
    }

    // setup also reports sub-stages (launching_steam, logging_in) — collapse
    // anything unknown to the pre-bake lead-in.
    const ORDER: Record<string, number> = {
      Initializing: 0,
      downloading_cs2: 1,
      launching_cs2: 2,
      processing_shaders: 3,
      errored: 99,
    };
    const status =
      body.status in ORDER && body.status !== "Initializing"
        ? body.status
        : "Initializing";

    // Never regress the pipeline: a stale tick (e.g. setup re-reporting after
    // download) must not flip a completed stage back to pending. errored wins.
    const current = ORDER[node.shader_bake_status ?? "Initializing"] ?? 0;
    if (status !== "errored" && (ORDER[status] ?? 0) < current) {
      return;
    }

    await this.writeBakeProgress(
      gameServerNodeId,
      status,
      this.parseProgress(body.progress),
      this.parseProgressStage(body.progress_stage),
    );
  }

  private async writeBakeProgress(
    gameServerNodeId: string,
    status: string,
    progress: number | null,
    progress_stage: string | null,
  ): Promise<void> {
    const { game_server_nodes_by_pk: node } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: { id: gameServerNodeId },
        shader_bake_status: true,
        shader_bake_status_history: true,
      },
    });

    const nextHistory = this.nextStatusHistory(
      node?.shader_bake_status_history,
      node?.shader_bake_status,
      status,
      progress,
      progress_stage,
    );

    await this.hasura.mutation({
      update_game_server_nodes_by_pk: {
        __args: {
          pk_columns: { id: gameServerNodeId },
          _set: {
            shader_bake_status: status,
            shader_bake_progress: progress,
            shader_bake_progress_stage: progress_stage,
            shader_bake_status_history: nextHistory,
          },
        },
        id: true,
      },
    });
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
    steamAccount: ClaimedSteamAccount | null = null,
  ): V1Job {
    const steamUser = steamAccount?.username ?? this.steamConfig.steamUser;
    const steamPassword =
      steamAccount?.password ?? this.steamConfig.steamPassword;
    const containerName =
      mode === "create-clips"
        ? "clips"
        : mode === "demo"
          ? "demo"
          : mode === "batch-highlights"
            ? "batch"
            : mode === "warm-shaders"
              ? "warm"
              : "live";
    const args =
      mode === "live"
        ? ["live"]
        : mode === "demo"
          ? ["demo"]
          : mode === "batch-highlights"
            ? ["batch-highlights"]
            : mode === "warm-shaders"
              ? ["warm-shaders"]
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
            hostNetwork: true,
            dnsPolicy: "ClusterFirstWithHostNet",
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
                // Override via GAME_STREAMER_IMAGE (see configs/game-servers.ts).
                image: this.gameServerConfig.gameStreamerImage,
                // Mutable tag; force each pod start to resolve the latest digest.
                imagePullPolicy: "Always",
                securityContext: { privileged: true },
                args,
                ports: exposesSpecPorts
                  ? [{ name: "spec", containerPort: 1350 }]
                  : undefined,
                env: [
                  { name: "MATCH_ID", value: matchId },
                  { name: "DISPLAY_SIZEW", value: "1920" },
                  { name: "DISPLAY_SIZEH", value: "1080" },
                  { name: "API_BASE", value: resolveInClusterApiBase() },
                  // Forward the configured public HLS host so the streamer
                  // can log/print correct watch URLs (otherwise the scripts
                  // fall back to a hardcoded hls.5stack.gg).
                  ...(process.env.GAME_STREAM_DOMAIN
                    ? [
                        {
                          name: "GAME_STREAM_DOMAIN",
                          value: process.env.GAME_STREAM_DOMAIN,
                        },
                      ]
                    : []),
                  // DEBUG_STREAM=1 → pod captures from boot (watch a hang
                  // via the "WATCH" HLS URL it logs).
                  ...(process.env.DEBUG_STREAM
                    ? [
                        {
                          name: "DEBUG_STREAM",
                          value: process.env.DEBUG_STREAM,
                        },
                      ]
                    : []),
                  ...(steamUser
                    ? [{ name: "STEAM_USER", value: steamUser }]
                    : []),
                  ...(steamPassword
                    ? [{ name: "STEAM_PASSWORD", value: steamPassword }]
                    : []),
                  ...extraEnv,
                ],
                // No CPU request/limit — 1 streamer per GPU node, so let it
                // use every core (uncapped = no CFS throttling; the CPU-bound
                // shader compile wants them all). GPU + memory still bounded.
                resources: {
                  limits: {
                    memory: "16Gi",
                    "nvidia.com/gpu": "1",
                  },
                  requests: {
                    memory: "2Gi",
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
