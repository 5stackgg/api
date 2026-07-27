import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";
import { HasuraService } from "src/hasura/hasura.service";
import Redis from "ioredis";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemService } from "src/system/system.service";
import { CacheService } from "src/cache/cache.service";
import {
  TelemetryFeature,
  TelemetryPayload,
  TELEMETRY_SCHEMA_VERSION,
} from "./types/TelemetryPayload";

@Injectable()
export class TelemetryService {
  private readonly appConfig: AppConfig;
  private readonly redis: Redis;

  // Every setting named `public.%` is readable by guests (see the settings
  // table's select permissions). The install id must never carry that prefix.
  private static readonly InstallIdSetting = "telemetry_install_id";

  // A feature is "on" when its setting says so, but the absent-row default
  // differs per feature and has to match what the app itself does, otherwise
  // an untouched install reports the opposite of what its users see.
  private static readonly FeatureFlags: Record<
    string,
    { setting: string; defaultEnabled: boolean }
  > = {
    // Not every switch is a `public.` setting — auto highlight generation is
    // an unprefixed one, and the GPU workloads below are toggled per node.
    highlights: { setting: "auto_generate_match_clips", defaultEnabled: false },
    highlights_imported: {
      setting: "auto_generate_match_clips_imported",
      defaultEnabled: false,
    },
    clip_branding: { setting: "clip_bake_branding", defaultEnabled: false },
    leagues: { setting: "public.leagues_enabled", defaultEnabled: false },
    seasons: { setting: "public.seasons_enabled", defaultEnabled: false },
    events: { setting: "public.events_enabled", defaultEnabled: false },
    news: { setting: "public.news_enabled", defaultEnabled: false },
    scrims: { setting: "public.scrim_finder_enabled", defaultEnabled: true },
    matchmaking: { setting: "public.matchmaking", defaultEnabled: false },
    custom_pages: {
      setting: "public.custom_pages_enabled",
      defaultEnabled: false,
    },
    external_matches: {
      setting: "public.external_matches_enabled",
      defaultEnabled: false,
    },
    faceit_import: {
      setting: "public.faceit_import_enabled",
      defaultEnabled: false,
    },
    steam_presence: {
      setting: "public.steam_presence_enabled",
      defaultEnabled: false,
    },
    discord_bot: {
      setting: "public.supports_discord_bot",
      defaultEnabled: false,
    },
    game_server_nodes: {
      setting: "supports_game_server_nodes",
      defaultEnabled: false,
    },
    version_pinning: {
      setting: "supports_game_server_version_pinning",
      defaultEnabled: false,
    },
    stream_login_protection: {
      setting: "public.require_login_for_live_streams",
      defaultEnabled: false,
    },
    player_name_registration: {
      setting: "public.player_name_registration",
      defaultEnabled: false,
    },
    league_division_requests: {
      setting: "public.league_allow_division_request",
      defaultEnabled: false,
    },
  };

  // A match this panel actually hosted. Imported demos are stamped with a
  // started_at (from demo metadata, or the import time when that is missing),
  // so started_at alone would count every FACEIT import as a match we ran.
  // external_id catches the case a 5stack-server demo is imported back in,
  // which keeps source = '5stack'.
  private static nativeMatch(alias?: string) {
    const column = TelemetryService.column(alias);

    return `${column("started_at")} IS NOT NULL
      AND ${column("source")} = '5stack'
      AND ${column("external_id")} IS NULL`;
  }

  private static importedMatch(alias?: string) {
    const column = TelemetryService.column(alias);

    return `${column("started_at")} IS NOT NULL
      AND (${column("source")} <> '5stack' OR ${column("external_id")} IS NOT NULL)`;
  }

  private static column(alias?: string) {
    return (name: string) => (alias ? `${alias}.${name}` : name);
  }

  // populate_game_servers materializes a `servers` row for every port pair in
  // a node's range the moment the node is enabled, so a node with a 216 port
  // range adds 108 rows nobody provisioned. Counting raw rows reports a fleet
  // of thousands of servers that do not exist.
  private static readonly RealServer = `(game_server_node_id IS NULL OR is_dedicated)`;

  private static activeLineups(interval: string) {
    const recent = `${TelemetryService.nativeMatch("m")}
      AND m.effective_at >= now() - interval '${interval}'`;

    return `SELECT m.lineup_1_id FROM public.matches m WHERE ${recent}
            UNION
            SELECT m.lineup_2_id FROM public.matches m WHERE ${recent}`;
  }

  constructor(
    private readonly logger: Logger,
    private readonly redisManagerService: RedisManagerService,
    private readonly hasuraService: HasuraService,
    private readonly configService: ConfigService,
    private readonly postgres: PostgresService,
    private readonly systemService: SystemService,
    private readonly cache: CacheService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
    this.redis = this.redisManagerService.getConnection();
  }

  async send() {
    if (!(await this.isEnabled())) {
      this.logger.log("telemetry is disabled");
      return;
    }

    let payload: TelemetryPayload;

    try {
      payload = await this.collect();
    } catch (error) {
      this.logger.warn("unable to collect telemetry", error);
      return;
    }

    try {
      await fetch("https://5stack.gg/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      this.logger.warn("unable to send telemetry", error);
    }
  }

  public async collect(): Promise<TelemetryPayload> {
    const [installId, settings, counts, byType, bySource] = await Promise.all([
      this.getInstallId(),
      this.getSettings(),
      this.getCounts(),
      this.getMatchesByType(),
      this.getMatchesBySource(),
    ]);

    return {
      schema: TELEMETRY_SCHEMA_VERSION,
      install_id: installId,
      installed_at: counts.installed_at
        ? new Date(counts.installed_at).toISOString()
        : null,
      panel_version: await this.getPanelVersion(),
      plugin_runtime: settings.get("public.game_server_plugin_runtime") ?? null,
      nodes: {
        total: counts.nodes_total,
        enabled: counts.nodes_enabled,
        online: counts.nodes_online,
        regions: counts.nodes_regions,
        gpu: counts.gpu_nodes,
      },
      servers: {
        total: counts.servers_total,
        enabled: counts.servers_enabled,
        dedicated: counts.servers_dedicated,
        public: counts.servers_public,
        capacity: counts.servers_capacity,
      },
      matches: {
        total: counts.matches_ran,
        created: counts.matches_created,
        week: counts.matches_week,
        month: counts.matches_month,
        year: counts.matches_year,
        maps_played: counts.maps_played,
        by_type: byType,
        by_source: bySource,
        tournament: counts.matches_tournament,
        league: counts.matches_league,
        scrim: counts.matches_scrim,
        external: {
          total: counts.matches_external,
          week: counts.matches_external_week,
          month: counts.matches_external_month,
          year: counts.matches_external_year,
        },
      },
      players: {
        known: counts.players_known,
        registered: counts.players_registered,
        played: counts.players_played,
        active_7d: counts.players_active_7d,
        active_30d: counts.players_active_30d,
        teams: counts.teams_total,
      },
      features: this.buildFeatures(settings, counts),
    };
  }

  async record(ip: string, country: string, data: unknown) {
    const payload = TelemetryService.sanitize(data);

    // Panels older than the payload rollout POST an empty body forever. They
    // still count as online, keyed by address since that is all they send.
    await this.redis.setex(
      `online_system:${payload?.install_id ?? ip}`,
      60 * 60,
      JSON.stringify(payload ?? {}),
    );

    if (!payload) {
      return;
    }

    await this.persist(payload, country);
  }

  // SCAN rather than KEYS: this runs on a per-minute poll, and KEYS walks the
  // whole keyspace in one blocking command that stalls every other client.
  async getOnlineSystemsCount(): Promise<number> {
    let cursor = "0";
    // SCAN can hand back the same key on more than one pass, so count distinct.
    const seen = new Set<string>();

    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        "online_system:*",
        "COUNT",
        1000,
      );
      cursor = next;
      for (const key of keys) {
        seen.add(key);
      }
    } while (cursor !== "0");

    return seen.size;
  }

  // The nav badge polls this action every minute for `online` alone, and a
  // Hasura action handler cannot see the GraphQL selection set — so the
  // aggregates are cached and only the Redis-backed online count runs per call.
  // Panels report hourly, so nothing here goes stale within the TTL.
  async getFleetStats() {
    const aggregates = await this.cache.remember(
      "telemetry:fleet",
      async () => {
        const [installs, totals, features, growth, activity] =
          await Promise.all([
            this.getInstallCounts(),
            this.getFleetTotals(),
            this.getFeatureAdoption(),
            this.getInstallGrowth(),
            this.getFleetActivity(),
          ]);

        return { installs, totals, features, growth, activity };
      },
      300,
    );

    return {
      online: await this.getOnlineSystemsCount(),
      ...aggregates,
    };
  }

  private async getInstallCounts() {
    const [row] = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         count(*)                                                                   AS total,
         count(*) FILTER (WHERE last_seen_at >= now() - interval '24 hours')        AS active24h,
         count(*) FILTER (WHERE last_seen_at >= now() - interval '7 days')          AS active7d,
         count(*) FILTER (WHERE last_seen_at >= now() - interval '30 days')         AS active30d,
         count(*) FILTER (WHERE first_seen_at >= now() - interval '30 days')        AS new30d,
         count(*) FILTER (WHERE first_seen_at < now() - interval '180 days'
                            AND last_seen_at >= now() - interval '7 days')          AS retained180d
       FROM public.telemetry_installs`,
    );

    return TelemetryService.toIntegers(row, [
      "total",
      "active24h",
      "active7d",
      "active30d",
      "new30d",
      "retained180d",
    ]);
  }

  // Summed across the latest payload of every install seen in the last 30 days.
  // Installs that have gone dark are excluded so the fleet picture does not keep
  // counting servers that were torn down a year ago.
  private async getFleetTotals() {
    const [row] = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         coalesce(sum((payload->'nodes'->>'total')::numeric), 0)              AS "gameServerNodes",
         coalesce(sum((payload->'nodes'->>'gpu')::numeric), 0)                AS "gpuNodes",
         coalesce(sum((payload->'servers'->>'total')::numeric), 0)            AS servers,
         coalesce(sum((payload->'servers'->>'dedicated')::numeric), 0)        AS "dedicatedServers",
         coalesce(sum((payload->'servers'->>'public')::numeric), 0)           AS "publicServers",
         coalesce(sum((payload->'servers'->>'capacity')::numeric), 0)         AS "serverCapacity",
         coalesce(sum((payload->'matches'->>'total')::numeric), 0)            AS matches,
         coalesce(sum((payload->'matches'->>'week')::numeric), 0)             AS "matchesWeek",
         coalesce(sum((payload->'matches'->>'month')::numeric), 0)            AS "matchesMonth",
         coalesce(sum((payload->'matches'->>'year')::numeric), 0)             AS "matchesYear",
         coalesce(sum((payload->'matches'->'external'->>'total')::numeric), 0) AS "matchesImported",
         coalesce(sum((payload->'matches'->'external'->>'month')::numeric), 0) AS "matchesImportedMonth",
         coalesce(sum((payload->'matches'->>'maps_played')::numeric), 0)      AS "mapsPlayed",
         coalesce(sum((payload->'players'->>'known')::numeric), 0)            AS "playersKnown",
         coalesce(sum((payload->'players'->>'registered')::numeric), 0)       AS "playersRegistered",
         coalesce(sum((payload->'players'->>'played')::numeric), 0)           AS "playersPlayed",
         coalesce(sum((payload->'players'->>'active_30d')::numeric), 0)       AS "playersActive30d",
         coalesce(sum((payload->'players'->>'teams')::numeric), 0)            AS teams
       FROM public.telemetry_installs
       WHERE last_seen_at >= now() - interval '30 days'
         AND payload ? 'matches'`,
    );

    return TelemetryService.toIntegers(row, [
      "gameServerNodes",
      "gpuNodes",
      "servers",
      "dedicatedServers",
      "publicServers",
      "serverCapacity",
      "matches",
      "matchesWeek",
      "matchesMonth",
      "matchesYear",
      "matchesImported",
      "matchesImportedMonth",
      "mapsPlayed",
      "playersKnown",
      "playersRegistered",
      "playersPlayed",
      "playersActive30d",
      "teams",
    ]);
  }

  private async getFeatureAdoption() {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         f.key                                                                AS key,
         count(*) FILTER (WHERE f.value->>'enabled' = 'true')                 AS enabled,
         -- Separates "no panel turned it on" from "this feature has no switch":
         -- a flagless feature reports a JSON null, which ->> yields as SQL NULL.
         count(*) FILTER (WHERE f.value->>'enabled' IS NOT NULL)              AS flagged,
         count(*)                                                             AS reporting,
         count(*) FILTER (WHERE (f.value->>'count')::numeric > 0)             AS "installsUsing",
         coalesce(sum((f.value->>'count')::numeric), 0)                       AS total
       FROM public.telemetry_installs i,
            LATERAL jsonb_each(coalesce(i.payload->'features', '{}'::jsonb)) f(key, value)
       WHERE i.last_seen_at >= now() - interval '30 days'
       GROUP BY f.key
       ORDER BY total DESC, f.key ASC`,
    );

    return rows.map((row) => ({
      key: row.key,
      ...TelemetryService.toIntegers(row, [
        "enabled",
        "flagged",
        "reporting",
        "installsUsing",
        "total",
      ]),
    }));
  }

  private async getInstallGrowth() {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         to_char(date_trunc('month', first_seen_at), 'YYYY-MM') AS month,
         count(*)                                               AS installs
       FROM public.telemetry_installs
       GROUP BY 1
       ORDER BY 1 ASC`,
    );

    return rows.map((row) => ({
      month: row.month,
      ...TelemetryService.toIntegers(row, ["installs"]),
    }));
  }

  // Matches per day come from the delta of each install's all-time counter, so
  // a missed heartbeat shifts a day's matches onto the next report rather than
  // losing them. GREATEST clamps the negative delta a wiped or restored
  // database would otherwise contribute.
  private async getFleetActivity() {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `WITH daily AS (
         SELECT
           install_id,
           day,
           (payload->'matches'->>'total')::numeric AS total,
           lag((payload->'matches'->>'total')::numeric)
             OVER (PARTITION BY install_id ORDER BY day) AS previous
         FROM public.telemetry_snapshots
         WHERE day >= current_date - 90
           AND payload ? 'matches'
       )
       SELECT
         to_char(day, 'YYYY-MM-DD')                                        AS day,
         count(DISTINCT install_id)                                        AS installs,
         coalesce(sum(greatest(total - coalesce(previous, total), 0)), 0)  AS matches
       FROM daily
       GROUP BY day
       ORDER BY day ASC`,
    );

    return rows.map((row) => ({
      day: row.day,
      ...TelemetryService.toIntegers(row, ["installs", "matches"]),
    }));
  }

  // `const T` keeps the key literals: without it T widens to `string`, the
  // return type becomes an index signature, and spreading it into an object
  // literal silently drops every property from the caller's type.
  private static toIntegers<const T extends string>(
    row: Record<string, any> | undefined,
    keys: readonly T[],
  ): Record<T, number> {
    const values = {} as Record<T, number>;

    for (const key of keys) {
      values[key] = Number(row?.[key] ?? 0);
    }

    return values;
  }

  private async persist(payload: TelemetryPayload, country: string) {
    await this.postgres.query(
      `INSERT INTO public.telemetry_installs
         (install_id, first_seen_at, last_seen_at, installed_at, panel_version, schema_version, country, payload)
       VALUES ($1, now(), now(), $2, $3, $4, $5, $6)
       ON CONFLICT (install_id) DO UPDATE SET
         last_seen_at = now(),
         installed_at = EXCLUDED.installed_at,
         panel_version = EXCLUDED.panel_version,
         schema_version = EXCLUDED.schema_version,
         country = EXCLUDED.country,
         payload = EXCLUDED.payload`,
      [
        payload.install_id,
        payload.installed_at,
        payload.panel_version,
        payload.schema,
        country || null,
        JSON.stringify(payload),
      ],
    );

    await this.postgres.query(
      `INSERT INTO public.telemetry_snapshots (install_id, day, reported_at, payload)
       VALUES ($1, current_date, now(), $2)
       ON CONFLICT (install_id, day) DO UPDATE SET
         reported_at = now(),
         payload = EXCLUDED.payload`,
      [payload.install_id, JSON.stringify(payload)],
    );
  }

  private static readonly MaxCount = 100_000_000;
  private static readonly MaxMapKeys = 50;

  // Anything arriving here is unauthenticated input from a self-hosted panel.
  // Rebuild the payload from known keys only so a forged body cannot inject
  // fields, unbounded maps, or values the aggregation SQL would choke casting.
  private static sanitize(data: unknown): TelemetryPayload | null {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }

    const body = data as Record<string, any>;

    if (!TelemetryService.isUuid(body.install_id)) {
      return null;
    }

    const int = (value: unknown) => {
      const number = Math.floor(Number(value));

      if (!Number.isFinite(number) || number < 0) {
        return 0;
      }

      return Math.min(number, TelemetryService.MaxCount);
    };

    const section = (value: unknown): Record<string, any> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
      }

      return value as Record<string, any>;
    };

    const nodes = section(body.nodes);
    const servers = section(body.servers);
    const matches = section(body.matches);
    const players = section(body.players);

    return {
      schema: int(body.schema),
      install_id: body.install_id,
      installed_at: TelemetryService.sanitizeDate(body.installed_at),
      panel_version: TelemetryService.sanitizeText(body.panel_version, 64),
      plugin_runtime: TelemetryService.sanitizeText(body.plugin_runtime, 32),
      nodes: {
        total: int(nodes.total),
        enabled: int(nodes.enabled),
        online: int(nodes.online),
        regions: int(nodes.regions),
        gpu: int(nodes.gpu),
      },
      servers: {
        total: int(servers.total),
        enabled: int(servers.enabled),
        dedicated: int(servers.dedicated),
        public: int(servers.public),
        capacity: int(servers.capacity),
      },
      matches: {
        total: int(matches.total),
        created: int(matches.created),
        week: int(matches.week),
        month: int(matches.month),
        year: int(matches.year),
        maps_played: int(matches.maps_played),
        by_type: TelemetryService.sanitizeCountMap(matches.by_type, int),
        by_source: TelemetryService.sanitizeCountMap(matches.by_source, int),
        tournament: int(matches.tournament),
        league: int(matches.league),
        scrim: int(matches.scrim),
        external: {
          total: int(section(matches.external).total),
          week: int(section(matches.external).week),
          month: int(section(matches.external).month),
          year: int(section(matches.external).year),
        },
      },
      players: {
        known: int(players.known),
        registered: int(players.registered),
        played: int(players.played),
        active_7d: int(players.active_7d),
        active_30d: int(players.active_30d),
        teams: int(players.teams),
      },
      features: TelemetryService.sanitizeFeatures(body.features, int),
    };
  }

  private static isUuid(value: unknown) {
    return (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    );
  }

  private static sanitizeText(value: unknown, max: number) {
    if (typeof value !== "string" || !value) {
      return null;
    }

    return value.slice(0, max);
  }

  private static sanitizeDate(value: unknown) {
    if (typeof value !== "string") {
      return null;
    }

    const date = new Date(value);

    if (isNaN(date.getTime())) {
      return null;
    }

    return date.toISOString();
  }

  private static sanitizeCountMap(
    value: unknown,
    int: (value: unknown) => number,
  ): Record<string, number> {
    const counts: Record<string, number> = {};

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return counts;
    }

    for (const [key, count] of Object.entries(value).slice(
      0,
      TelemetryService.MaxMapKeys,
    )) {
      counts[key.slice(0, 32)] = int(count);
    }

    return counts;
  }

  private static sanitizeFeatures(
    value: unknown,
    int: (value: unknown) => number,
  ): Record<string, TelemetryFeature> {
    const features: Record<string, TelemetryFeature> = {};

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return features;
    }

    for (const [key, feature] of Object.entries(value).slice(
      0,
      TelemetryService.MaxMapKeys,
    )) {
      if (!feature || typeof feature !== "object") {
        continue;
      }

      const { enabled, count } = feature as Record<string, any>;

      features[key.slice(0, 32)] = {
        enabled: typeof enabled === "boolean" ? enabled : null,
        count: count === null || count === undefined ? null : int(count),
      };
    }

    return features;
  }

  private buildFeatures(
    settings: Map<string, string>,
    counts: TelemetryCounts,
  ): Record<string, TelemetryFeature> {
    const usage: Record<string, number | null> = {
      tournaments: counts.tournaments,
      leagues: counts.league_seasons,
      seasons: counts.seasons,
      events: counts.events,
      news: counts.news_articles,
      highlights: counts.match_clips,
      clip_renders: counts.clip_render_jobs,
      system_alerts: counts.system_alerts,
      awards: counts.award_recipients,
      scrims: counts.scrim_requests,
      matchmaking: counts.lobbies,
      custom_pages: counts.custom_pages,
      external_matches: counts.matches_external,
      faceit_import: counts.matches_faceit,
      draft_games: counts.draft_games,
      demos: counts.demos,
      sanctions: counts.sanctions,
      api_keys: counts.api_keys,
      gamedata_validations: counts.gamedata_validations,
      demo_playback: counts.demos,
      live_streaming: null,
    };

    // Switched per GPU node instead of by a setting: on means at least one node
    // is currently carrying that workload.
    const gpuWorkloads: Record<string, boolean> = {
      demo_playback: counts.gpu_demo_nodes > 0,
      clip_renders: counts.gpu_render_nodes > 0,
      live_streaming: counts.gpu_stream_nodes > 0,
    };

    const features: Record<string, TelemetryFeature> = {};

    for (const key of new Set([
      ...Object.keys(TelemetryService.FeatureFlags),
      ...Object.keys(usage),
      ...Object.keys(gpuWorkloads),
    ])) {
      const flag = TelemetryService.FeatureFlags[key];

      features[key] = {
        enabled: flag
          ? TelemetryService.isFlagEnabled(
              settings.get(flag.setting),
              flag.defaultEnabled,
            )
          : (gpuWorkloads[key] ?? null),
        count: usage[key] ?? null,
      };
    }

    features.branding = {
      enabled: TelemetryService.hasBranding(settings),
      count: null,
    };

    return features;
  }

  private static isFlagEnabled(value: string | undefined, fallback: boolean) {
    if (value === undefined) {
      return fallback;
    }

    return value === "true";
  }

  private static hasBranding(settings: Map<string, string>) {
    for (const [name, value] of settings) {
      if (
        (name === "public.brand_name" ||
          name === "public.logo_url" ||
          name.startsWith("public.color_")) &&
        value
      ) {
        return true;
      }
    }

    return false;
  }

  private async getInstallId(): Promise<string> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `WITH created AS (
         INSERT INTO public.settings (name, value)
         VALUES ($1, gen_random_uuid()::text)
         ON CONFLICT (name) DO NOTHING
         RETURNING value
       )
       SELECT value FROM created
       UNION ALL
       SELECT value FROM public.settings WHERE name = $1
       LIMIT 1`,
      [TelemetryService.InstallIdSetting],
    );

    return row?.value;
  }

  // Telemetry is the least important thing a panel does, so it is never allowed
  // to hold a connection open. SET LOCAL scopes the timeout to this transaction
  // rather than leaking onto a pooled connection the rest of the app reuses. A
  // timeout aborts the whole collection and send() skips the hour.
  private static readonly CollectTimeoutMs = 15_000;

  private async collectQuery<T>(sql: string): Promise<T> {
    return await this.postgres.transaction(async (client) => {
      await client.query(
        `SET LOCAL statement_timeout = ${TelemetryService.CollectTimeoutMs}`,
      );

      const result = await client.query(sql);

      return result.rows as T;
    });
  }

  private async getSettings(): Promise<Map<string, string>> {
    const rows = await this.collectQuery<
      Array<{ name: string; value: string }>
    >(`SELECT name, value FROM public.settings`);

    return new Map(rows.map(({ name, value }) => [name, value]));
  }

  private async getPanelVersion() {
    try {
      return (await this.systemService.getPanelVersion()) || null;
    } catch (error) {
      this.logger.warn("unable to read panel version for telemetry", error);
      return null;
    }
  }

  private async getMatchesByType(): Promise<Record<string, number>> {
    const rows = await this.collectQuery<
      Array<{ type: string; count: string }>
    >(
      `SELECT o.type, count(*) AS count
         FROM public.matches m
         JOIN public.match_options o ON o.id = m.match_options_id
        WHERE m.started_at IS NOT NULL
        GROUP BY o.type`,
    );

    return TelemetryService.toCountMap(rows, "type");
  }

  private async getMatchesBySource(): Promise<Record<string, number>> {
    const rows = await this.collectQuery<
      Array<{ source: string; count: string }>
    >(
      `SELECT source, count(*) AS count
         FROM public.matches
        WHERE started_at IS NOT NULL
        GROUP BY source`,
    );

    return TelemetryService.toCountMap(rows, "source");
  }

  private static toCountMap(
    rows: Array<Record<string, any>>,
    key: string,
  ): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const row of rows) {
      if (!row[key]) {
        continue;
      }

      counts[row[key]] = Number(row.count);
    }

    return counts;
  }

  private async getCounts(): Promise<TelemetryCounts> {
    const [row] = await this.collectQuery<Array<TelemetryCounts>>(
      `SELECT
        (SELECT min(created_at) FROM public.matches)                                     AS installed_at,

        (SELECT count(*) FROM public.game_server_nodes)                                  AS nodes_total,
        (SELECT count(*) FROM public.game_server_nodes WHERE enabled)                    AS nodes_enabled,
        (SELECT count(*) FROM public.game_server_nodes WHERE status = 'Online')          AS nodes_online,
        (SELECT count(DISTINCT region) FROM public.game_server_nodes
          WHERE region IS NOT NULL)                                                      AS nodes_regions,

        -- Demo playback, clip rendering and live streaming are each switched
        -- per GPU node rather than by a setting, so "on" means at least one
        -- node is carrying that workload.
        (SELECT count(*) FROM public.game_server_nodes WHERE gpu)                        AS gpu_nodes,
        (SELECT count(*) FROM public.game_server_nodes
          WHERE gpu AND gpu_demos_enabled)                                               AS gpu_demo_nodes,
        (SELECT count(*) FROM public.game_server_nodes
          WHERE gpu AND gpu_rendering_enabled)                                           AS gpu_render_nodes,
        (SELECT count(*) FROM public.game_server_nodes
          WHERE gpu AND gpu_streaming_enabled)                                           AS gpu_stream_nodes,

        (SELECT count(*) FROM public.servers
          WHERE ${TelemetryService.RealServer})                                          AS servers_total,
        (SELECT count(*) FROM public.servers
          WHERE ${TelemetryService.RealServer} AND enabled)                              AS servers_enabled,
        (SELECT count(*) FROM public.servers WHERE is_dedicated)                         AS servers_dedicated,
        (SELECT count(*) FROM public.servers
          WHERE ${TelemetryService.RealServer} AND type <> 'Ranked')                     AS servers_public,
        (SELECT coalesce(sum(max_players), 0) FROM public.servers
          WHERE ${TelemetryService.RealServer})                                          AS servers_capacity,

        (SELECT count(*) FROM public.matches)                                            AS matches_created,
        (SELECT count(*) FROM public.matches WHERE ${TelemetryService.nativeMatch()})      AS matches_ran,
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.nativeMatch()}
            AND effective_at >= now() - interval '7 days')                               AS matches_week,
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.nativeMatch()}
            AND effective_at >= now() - interval '30 days')                              AS matches_month,
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.nativeMatch()}
            AND effective_at >= now() - interval '365 days')                             AS matches_year,
        (SELECT count(*) FROM public.match_maps mm
           JOIN public.matches m ON m.id = mm.match_id
          WHERE mm.status = 'Finished'
            AND ${TelemetryService.nativeMatch("m")})                                     AS maps_played,

        (SELECT count(*) FROM public.matches WHERE ${TelemetryService.importedMatch()})     AS matches_external,
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.importedMatch()}
            AND effective_at >= now() - interval '7 days')                                AS matches_external_week,
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.importedMatch()}
            AND effective_at >= now() - interval '30 days')                               AS matches_external_month,
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.importedMatch()}
            AND effective_at >= now() - interval '365 days')                              AS matches_external_year,
        (SELECT count(*) FROM public.matches WHERE source = 'faceit')                     AS matches_faceit,

        (SELECT count(DISTINCT b.match_id) FROM public.tournament_brackets b
          WHERE b.match_id IS NOT NULL)                                                  AS matches_tournament,
        (SELECT count(DISTINCT b.match_id)
           FROM public.tournament_brackets b
           JOIN public.tournament_stages st ON st.id = b.tournament_stage_id
           JOIN public.league_season_divisions d ON d.tournament_id = st.tournament_id
          WHERE b.match_id IS NOT NULL)                                                  AS matches_league,
        (SELECT count(DISTINCT r.match_id) FROM public.team_scrim_requests r
          WHERE r.match_id IS NOT NULL)                                                  AS matches_scrim,

        -- Connect events, lineup syncs, demo imports and sanctions all create a
        -- players row, so the table is mostly steam ids that never signed in.
        -- last_sign_in_at is only ever written by the Steam login callback.
        (SELECT count(*) FROM public.players)                                            AS players_known,
        (SELECT count(*) FROM public.players WHERE last_sign_in_at IS NOT NULL)          AS players_registered,
        -- Stats land per map from live round events and from parsed demos, so
        -- this is everyone who played rather than everyone who was rostered.
        (SELECT count(DISTINCT steam_id) FROM public.player_match_map_stats)             AS players_played,
        (SELECT count(*) FROM public.teams)                                              AS teams_total,
        -- An OR across both lineup columns cannot use an index and forces a
        -- join over every lineup row. Feeding the two sides in separately lets
        -- this ride the (match_lineup_id, steam_id) unique index instead.
        (SELECT count(DISTINCT p.steam_id)
           FROM public.match_lineup_players p
          WHERE p.steam_id IS NOT NULL
            AND p.match_lineup_id IN (
              ${TelemetryService.activeLineups("7 days")}
            ))                                                                           AS players_active_7d,
        (SELECT count(DISTINCT p.steam_id)
           FROM public.match_lineup_players p
          WHERE p.steam_id IS NOT NULL
            AND p.match_lineup_id IN (
              ${TelemetryService.activeLineups("30 days")}
            ))                                                                           AS players_active_30d,

        (SELECT count(*) FROM public.tournaments)                                        AS tournaments,
        (SELECT count(*) FROM public.league_seasons)                                     AS league_seasons,
        (SELECT count(*) FROM public.seasons)                                            AS seasons,
        (SELECT count(*) FROM public.events)                                             AS events,
        (SELECT count(*) FROM public.news_articles)                                      AS news_articles,
        (SELECT count(*) FROM public.match_clips)                                        AS match_clips,
        (SELECT count(*) FROM public.clip_render_jobs)                                   AS clip_render_jobs,
        (SELECT count(*) FROM public.system_alerts)                                      AS system_alerts,
        (SELECT count(*) FROM public.award_recipients)                                   AS award_recipients,
        (SELECT count(*) FROM public.team_scrim_requests)                                AS scrim_requests,
        (SELECT count(*) FROM public.lobbies)                                            AS lobbies,
        (SELECT count(*) FROM public.custom_pages WHERE enabled)                         AS custom_pages,
        (SELECT count(*) FROM public.draft_games)                                        AS draft_games,
        (SELECT count(*) FROM public.match_map_demos)                                    AS demos,
        (SELECT count(*) FROM public.player_sanctions)                                   AS sanctions,
        (SELECT count(*) FROM public.api_keys)                                           AS api_keys,
        (SELECT count(*) FROM public.gamedata_signature_validations)                     AS gamedata_validations
      `,
    );

    return TelemetryService.toNumbers(row);
  }

  // pg returns bigint as a string so every count would serialize as "12".
  private static toNumbers(row: Record<string, any>): TelemetryCounts {
    const counts: Record<string, any> = {};

    for (const [key, value] of Object.entries(row ?? {})) {
      counts[key] = key === "installed_at" ? value : Number(value ?? 0);
    }

    return counts as TelemetryCounts;
  }

  private async isEnabled() {
    if (this.appConfig.webDomain.includes("://5stack.gg")) {
      return false;
    }

    const { settings_by_pk: telemetry } = await this.hasuraService.query({
      settings_by_pk: {
        __args: {
          name: "telemetry",
        },
        value: true,
      },
    });

    return telemetry?.value !== "false";
  }
}

type TelemetryCounts = {
  installed_at: string | null;
} & Record<string, number>;
