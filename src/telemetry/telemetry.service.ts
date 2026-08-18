import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "src/configs/types/AppConfig";
import Redis from "ioredis";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemService } from "src/system/system.service";
import { CacheService } from "src/cache/cache.service";
import {
  TelemetryCompetition,
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
    clip_branding: { setting: "clip_bake_branding", defaultEnabled: true },
    leagues: { setting: "public.leagues_enabled", defaultEnabled: false },
    seasons: { setting: "public.seasons_enabled", defaultEnabled: false },
    events: { setting: "public.events_enabled", defaultEnabled: false },
    news: { setting: "public.news_enabled", defaultEnabled: false },
    scrims: { setting: "public.scrim_finder_enabled", defaultEnabled: true },
    matchmaking: { setting: "public.matchmaking", defaultEnabled: true },
    voice_chat: { setting: "public.voice_chat_enabled", defaultEnabled: true },
    video_chat: { setting: "public.video_chat_enabled", defaultEnabled: true },
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
      defaultEnabled: true,
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
      defaultEnabled: true,
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

  // Reported with an `enabled` flag, but nothing an admin can switch: these are
  // read back from configured credentials, from the GPU workload switches on
  // each node, or from whether a brand has been filled in. The fleet page has
  // to tell them apart from settings or it offers an adoption rate for a
  // toggle that does not exist.
  private static readonly DetectedFeatures = new Set([
    "discord_bot",
    "game_server_nodes",
    "version_pinning",
    "demo_playback",
    "clip_renders",
    "live_streaming",
    "branding",
  ]);

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
    private readonly configService: ConfigService,
    private readonly postgres: PostgresService,
    private readonly systemService: SystemService,
    private readonly cache: CacheService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
    this.redis = this.redisManagerService.getConnection();
  }

  async send() {
    // The panel receiving the reports would otherwise report to itself.
    if (this.appConfig.webDomain.includes("://5stack.gg")) {
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
      },
      matches: {
        total: counts.matches_ran,
        created: counts.matches_created,
        week: counts.matches_week,
        month: counts.matches_month,
        year: counts.matches_year,
        maps_played: counts.maps_played,
        finished: counts.matches_finished,
        abandoned: counts.matches_abandoned,
        live: counts.matches_live,
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
        appearances: counts.player_appearances,
        active_7d: counts.players_active_7d,
        active_30d: counts.players_active_30d,
        teams: counts.teams_total,
      },
      competition: {
        tournaments: counts.tournaments,
        tournaments_finished: counts.tournaments_finished,
        tournament_teams: counts.tournament_teams,
        league_seasons: counts.league_seasons,
        league_seasons_finished: counts.league_seasons_finished,
        league_registrations: counts.league_registrations,
        league_teams: counts.league_teams,
        scrim_requests: counts.scrim_requests,
        events: counts.events,
        event_teams: counts.event_teams,
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
      // Versioned: a cached blob from the previous shape would leave the page
      // missing every field added since, for as long as the TTL lasts.
      "telemetry:fleet:v2",
      async () => {
        const [
          installs,
          totals,
          features,
          growth,
          activity,
          composition,
          distribution,
        ] = await Promise.all([
          this.getInstallCounts(),
          this.getFleetTotals(),
          this.getFeatureAdoption(),
          this.getInstallGrowth(),
          this.getFleetActivity(),
          this.getMatchComposition(),
          this.getFleetDistribution(),
        ]);

        return {
          installs,
          totals,
          features,
          growth,
          activity,
          ...composition,
          ...distribution,
        };
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
  // counting servers that were torn down a year ago. `panels` is that same set
  // counted, so the page can say which denominator every total is over.
  private async getFleetTotals() {
    const [row] = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         count(*)                                                             AS panels,
         coalesce(sum((payload->'nodes'->>'total')::numeric), 0)              AS "gameServerNodes",
         coalesce(sum((payload->'nodes'->>'enabled')::numeric), 0)            AS "gameServerNodesEnabled",
         coalesce(sum((payload->'nodes'->>'online')::numeric), 0)             AS "gameServerNodesOnline",
         -- Regions are named per panel, so this is how many each has stood up
         -- rather than how many distinct regions the fleet covers.
         coalesce(sum((payload->'nodes'->>'regions')::numeric), 0)            AS regions,
         coalesce(sum((payload->'nodes'->>'gpu')::numeric), 0)                AS "gpuNodes",
         coalesce(sum((payload->'servers'->>'total')::numeric), 0)            AS servers,
         coalesce(sum((payload->'servers'->>'enabled')::numeric), 0)          AS "serversEnabled",
         coalesce(sum((payload->'servers'->>'dedicated')::numeric), 0)        AS "dedicatedServers",
         coalesce(sum((payload->'servers'->>'public')::numeric), 0)           AS "publicServers",
         coalesce(sum((payload->'matches'->>'total')::numeric), 0)            AS matches,
         coalesce(sum((payload->'matches'->>'created')::numeric), 0)          AS "matchesCreated",
         coalesce(sum((payload->'matches'->>'week')::numeric), 0)             AS "matchesWeek",
         coalesce(sum((payload->'matches'->>'month')::numeric), 0)            AS "matchesMonth",
         coalesce(sum((payload->'matches'->>'year')::numeric), 0)             AS "matchesYear",
         -- A field added after a panel's build reports nothing, and summing
         -- that to zero reads as "no match ever finished". Count who actually
         -- supplied it so the page can say "not reported yet" instead.
         count(*) FILTER (WHERE payload->'matches'->>'finished' IS NOT NULL) AS "outcomesReported",
         coalesce(sum((payload->'matches'->>'finished')::numeric), 0)         AS "matchesFinished",
         coalesce(sum((payload->'matches'->>'abandoned')::numeric), 0)        AS "matchesAbandoned",
         coalesce(sum((payload->'matches'->>'live')::numeric), 0)             AS "matchesLive",
         coalesce(sum((payload->'matches'->>'tournament')::numeric), 0)       AS "matchesTournament",
         coalesce(sum((payload->'matches'->>'league')::numeric), 0)           AS "matchesLeague",
         coalesce(sum((payload->'matches'->>'scrim')::numeric), 0)            AS "matchesScrim",
         coalesce(sum((payload->'matches'->'external'->>'total')::numeric), 0) AS "matchesImported",
         coalesce(sum((payload->'matches'->'external'->>'month')::numeric), 0) AS "matchesImportedMonth",
         coalesce(sum((payload->'matches'->'external'->>'year')::numeric), 0)  AS "matchesImportedYear",
         coalesce(sum((payload->'matches'->>'maps_played')::numeric), 0)      AS "mapsPlayed",
         coalesce(sum((payload->'players'->>'known')::numeric), 0)            AS "playersKnown",
         coalesce(sum((payload->'players'->>'registered')::numeric), 0)       AS "playersRegistered",
         coalesce(sum((payload->'players'->>'played')::numeric), 0)           AS "playersPlayed",
         count(*) FILTER (
           WHERE payload->'players'->>'appearances' IS NOT NULL
         )                                                                    AS "appearancesReported",
         coalesce(sum((payload->'players'->>'appearances')::numeric), 0)      AS "playerAppearances",
         coalesce(sum((payload->'players'->>'active_7d')::numeric), 0)        AS "playersActive7d",
         coalesce(sum((payload->'players'->>'active_30d')::numeric), 0)       AS "playersActive30d",
         coalesce(sum((payload->'players'->>'teams')::numeric), 0)            AS teams,

         -- Same absent-vs-zero split as the match outcomes above: this whole
         -- section postdates the builds most of the fleet is running.
         count(*) FILTER (
           WHERE jsonb_typeof(payload->'competition') = 'object'
         )                                                                    AS "competitionReported",
         coalesce(sum((payload->'competition'->>'tournaments')::numeric), 0)           AS tournaments,
         coalesce(sum((payload->'competition'->>'tournaments_finished')::numeric), 0)  AS "tournamentsFinished",
         coalesce(sum((payload->'competition'->>'tournament_teams')::numeric), 0)      AS "tournamentTeams",
         coalesce(sum((payload->'competition'->>'league_seasons')::numeric), 0)        AS "leagueSeasons",
         coalesce(sum((payload->'competition'->>'league_seasons_finished')::numeric), 0) AS "leagueSeasonsFinished",
         coalesce(sum((payload->'competition'->>'league_registrations')::numeric), 0)  AS "leagueRegistrations",
         coalesce(sum((payload->'competition'->>'league_teams')::numeric), 0)          AS "leagueTeams",
         coalesce(sum((payload->'competition'->>'scrim_requests')::numeric), 0)        AS "scrimRequests",
         coalesce(sum((payload->'competition'->>'events')::numeric), 0)                AS events,
         coalesce(sum((payload->'competition'->>'event_teams')::numeric), 0)           AS "eventTeams"
       FROM public.telemetry_installs
       WHERE last_seen_at >= now() - interval '30 days'
         AND payload ? 'matches'`,
    );

    return TelemetryService.toIntegers(row, [
      "panels",
      "gameServerNodes",
      "gameServerNodesEnabled",
      "gameServerNodesOnline",
      "regions",
      "gpuNodes",
      "servers",
      "serversEnabled",
      "dedicatedServers",
      "publicServers",
      "matches",
      "matchesCreated",
      "matchesWeek",
      "matchesMonth",
      "matchesYear",
      "outcomesReported",
      "matchesFinished",
      "matchesAbandoned",
      "matchesLive",
      "matchesTournament",
      "matchesLeague",
      "matchesScrim",
      "matchesImported",
      "matchesImportedMonth",
      "matchesImportedYear",
      "mapsPlayed",
      "playersKnown",
      "playersRegistered",
      "playersPlayed",
      "appearancesReported",
      "playerAppearances",
      "playersActive7d",
      "playersActive30d",
      "teams",
      "competitionReported",
      "tournaments",
      "tournamentsFinished",
      "tournamentTeams",
      "leagueSeasons",
      "leagueSeasonsFinished",
      "leagueRegistrations",
      "leagueTeams",
      "scrimRequests",
      "events",
      "eventTeams",
    ]);
  }

  // Both breakdowns live in the payload already; nothing read them before, so
  // the page could say how many matches ran but never what kind they were.
  private async getMatchComposition() {
    const [types, sources] = await Promise.all([
      this.sumCountMap("by_type"),
      this.sumCountMap("by_source"),
    ]);

    return {
      matchTypes: types.map(({ name, ...counts }) => ({
        type: name,
        ...counts,
      })),
      matchSources: sources.map(({ name, ...counts }) => ({
        source: name,
        ...counts,
      })),
    };
  }

  private async sumCountMap(field: string) {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         e.key                                          AS name,
         count(*)                                       AS panels,
         coalesce(sum((e.value#>>'{}')::numeric), 0)    AS matches
       FROM public.telemetry_installs i,
            LATERAL jsonb_each(
              coalesce(i.payload->'matches'->'${field}', '{}'::jsonb)
            ) e(key, value)
       WHERE i.last_seen_at >= now() - interval '30 days'
         AND jsonb_typeof(e.value) = 'number'
       GROUP BY e.key
       ORDER BY matches DESC, e.key ASC`,
    );

    return rows.map((row) => ({
      name: row.name,
      ...TelemetryService.toIntegers(row, ["panels", "matches"]),
    }));
  }

  // Version and country are promoted to columns on arrival; the plugin runtime
  // only ever lands in the payload, so it has to be read back out of the json.
  private async getFleetDistribution() {
    const [versions, runtimes, countries] = await Promise.all([
      this.getVersionAdoption(),
      this.countInstallsBy("payload->>'plugin_runtime'"),
      this.countInstallsBy("country"),
    ]);

    return {
      versions,
      runtimes: runtimes.map(({ name, installs }) => ({
        runtime: name,
        installs,
      })),
      countries: countries.map(({ name, installs }) => ({
        country: name,
        installs,
      })),
    };
  }

  // A commit sha does not sort, so "newest" is decided by when each build first
  // showed up in anybody's report. Ranking that way turns a list of hashes --
  // which says nothing on its own -- into how far behind the fleet is running.
  private async getVersionAdoption() {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `WITH seen AS (
         SELECT
           payload->>'panel_version'                       AS version,
           min(day)                                        AS since
         FROM public.telemetry_snapshots
         WHERE coalesce(payload->>'panel_version', '') <> ''
         GROUP BY 1
       ),
       ranked AS (
         SELECT version, since,
                row_number() OVER (ORDER BY since DESC, version ASC) AS rank
         FROM seen
       )
       SELECT
         r.version                              AS version,
         r.rank                                 AS rank,
         to_char(r.since, 'YYYY-MM-DD')         AS since,
         count(i.install_id)                    AS installs
       FROM ranked r
       LEFT JOIN public.telemetry_installs i
              ON i.panel_version = r.version
             AND i.last_seen_at >= now() - interval '30 days'
       GROUP BY 1, 2, 3
       -- A build nobody is running any more is history, not fleet state.
       HAVING count(i.install_id) > 0
       ORDER BY r.rank ASC
       LIMIT 25`,
    );

    return rows.map((row) => ({
      version: row.version,
      since: row.since,
      ...TelemetryService.toIntegers(row, ["rank", "installs"]),
    }));
  }

  private async countInstallsBy(expression: string) {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT ${expression} AS name, count(*) AS installs
       FROM public.telemetry_installs
       WHERE last_seen_at >= now() - interval '30 days'
         AND ${expression} IS NOT NULL
         AND ${expression} <> ''
       GROUP BY 1
       ORDER BY installs DESC, name ASC
       LIMIT 25`,
    );

    return rows.map((row) => ({
      name: row.name,
      ...TelemetryService.toIntegers(row, ["installs"]),
    }));
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
         -- The same distinction for usage. Without it a feature nothing counts
         -- is indistinguishable from one every panel has left unused, and the
         -- page reports "0 of 40 panels using" for both.
         count(*) FILTER (WHERE f.value->>'count' IS NOT NULL)                AS counted,
         count(*) FILTER (WHERE (f.value->>'count')::numeric > 0)             AS "installsUsing",
         coalesce(sum((f.value->>'count')::numeric), 0)                       AS total
       FROM public.telemetry_installs i,
            LATERAL jsonb_each(coalesce(i.payload->'features', '{}'::jsonb)) f(key, value)
       WHERE i.last_seen_at >= now() - interval '30 days'
       GROUP BY f.key
       ORDER BY total DESC, f.key ASC`,
    );

    return rows.map((row) => {
      const counts = TelemetryService.toIntegers(row, [
        "enabled",
        "flagged",
        "reporting",
        "counted",
        "installsUsing",
        "total",
      ]);

      return {
        key: row.key,
        kind: TelemetryService.featureKind(row.key, counts.flagged),
        ...counts,
      };
    });
  }

  // Detected first. The `supports_*` ones are stored as settings and so are in
  // FeatureFlags too -- that is where their `enabled` comes from -- and asking
  // that map first labelled every one of them a toggle an admin could flip.
  //
  // Panels on other versions can report keys this one has never heard of, so
  // an unknown key falls back to what the reports themselves say: a boolean
  // means something switched it, the absence of one means it always ships on.
  private static featureKind(key: string, flagged: number) {
    if (TelemetryService.DetectedFeatures.has(key)) {
      return "detected";
    }

    if (TelemetryService.FeatureFlags[key]) {
      return "setting";
    }

    return flagged > 0 ? "detected" : "always";
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
         -- A week of lead-in that never gets plotted: the oldest day in the
         -- window has no earlier report to subtract from, so charting it
         -- directly pins the left edge of the line to zero every day.
         WHERE day >= current_date - 97
           AND payload ? 'matches'
       )
       SELECT
         to_char(day, 'YYYY-MM-DD')                                        AS day,
         count(DISTINCT install_id)                                        AS installs,
         coalesce(sum(greatest(total - coalesce(previous, total), 0)), 0)  AS matches
       FROM daily
       WHERE day >= current_date - 90
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

    const optionalInt = (value: unknown) =>
      value === null || value === undefined ? null : int(value);

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
      },
      matches: {
        total: int(matches.total),
        created: int(matches.created),
        week: int(matches.week),
        month: int(matches.month),
        year: int(matches.year),
        maps_played: int(matches.maps_played),
        // Absent stays absent. Defaulting these to 0 like every other counter
        // would make a panel that has never heard of them look like a panel
        // reporting that no match has ever finished.
        finished: optionalInt(matches.finished),
        abandoned: optionalInt(matches.abandoned),
        live: optionalInt(matches.live),
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
        appearances: optionalInt(players.appearances),
        active_7d: int(players.active_7d),
        active_30d: int(players.active_30d),
        teams: int(players.teams),
      },
      competition: TelemetryService.sanitizeCompetition(body.competition, int),
      features: TelemetryService.sanitizeFeatures(body.features, int),
    };
  }

  // Null in, null out. Rebuilding an absent section as a block of zeroes would
  // put every panel too old to report it into the fleet total as a zero.
  private static sanitizeCompetition(
    value: unknown,
    int: (value: unknown) => number,
  ): TelemetryCompetition | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const competition = value as Record<string, any>;

    return {
      tournaments: int(competition.tournaments),
      tournaments_finished: int(competition.tournaments_finished),
      tournament_teams: int(competition.tournament_teams),
      league_seasons: int(competition.league_seasons),
      league_seasons_finished: int(competition.league_seasons_finished),
      league_registrations: int(competition.league_registrations),
      league_teams: int(competition.league_teams),
      scrim_requests: int(competition.scrim_requests),
      events: int(competition.events),
      event_teams: int(competition.event_teams),
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
    const usage: Record<string, number> = {
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
      push_notifications: counts.push_subscriptions,
      // Playback sessions, not stored demos: the two were the same number
      // before, which made every panel holding a demo look like a panel
      // watching one.
      demo_playback: counts.demo_sessions,
      live_streaming: counts.match_streams,
      game_server_nodes: counts.nodes_total,
      version_pinning: counts.nodes_pinned,
      discord_bot: counts.players_discord,
      steam_presence: counts.steam_presence_friends,
      player_name_registration: counts.players_name_registered,
    };

    // Read back rather than switched. The GPU workloads are toggled per node,
    // so on means at least one node is carrying that work; branding is on once
    // a name, logo or colour has been filled in.
    const detected: Record<string, boolean> = {
      demo_playback: counts.gpu_demo_nodes > 0,
      clip_renders: counts.gpu_render_nodes > 0,
      live_streaming: counts.gpu_stream_nodes > 0,
      branding: TelemetryService.hasBranding(settings),
    };

    const features: Record<string, TelemetryFeature> = {};

    for (const key of new Set([
      ...Object.keys(TelemetryService.FeatureFlags),
      ...Object.keys(usage),
      ...Object.keys(detected),
    ])) {
      const flag = TelemetryService.FeatureFlags[key];

      features[key] = {
        enabled: flag
          ? TelemetryService.isFlagEnabled(
              settings.get(flag.setting),
              flag.defaultEnabled,
            )
          : (detected[key] ?? null),
        // Null rather than zero for a feature nothing counts: "0 of 40 panels
        // using" reads as nobody using it rather than as nothing measured.
        count: usage[key] ?? null,
      };
    }

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
    // Native only, so the breakdown adds up to the hosted match count rather
    // than to hosted plus imported.
    const rows = await this.collectQuery<
      Array<{ type: string; count: string }>
    >(
      `SELECT o.type, count(*) AS count
         FROM public.matches m
         JOIN public.match_options o ON o.id = m.match_options_id
        WHERE ${TelemetryService.nativeMatch("m")}
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
        -- The panel keeps no record of its own install date, so the oldest row
        -- it wrote stands in for one. least() skips nulls, which matters for a
        -- panel that has players but has not run a match yet.
        (SELECT least(
           (SELECT min(created_at) FROM public.matches),
           (SELECT min(created_at) FROM public.players)))                                AS installed_at,

        (SELECT count(*) FROM public.game_server_nodes)                                  AS nodes_total,
        (SELECT count(*) FROM public.game_server_nodes WHERE enabled)                    AS nodes_enabled,
        -- Enabled as well as up. A disabled node keeps reporting its status, so
        -- counting status alone puts nodes that cannot take a match into the
        -- online count and leaves online larger than enabled -- which stops the
        -- three node counts describing one population.
        (SELECT count(*) FROM public.game_server_nodes
          WHERE enabled AND status = 'Online')                                           AS nodes_online,
        (SELECT count(DISTINCT region) FROM public.game_server_nodes
          WHERE enabled AND region IS NOT NULL)                                          AS nodes_regions,

        -- Demo playback, clip rendering and live streaming are each switched
        -- per GPU node rather than by a setting, so "on" means at least one
        -- node is carrying that workload.
        --
        -- Every node count below is scoped to enabled. A node an operator has
        -- switched off is not capacity and cannot carry a workload, and once
        -- the disabled ones are counted the GPU total stops being a slice of
        -- the same population as the online/offline split.
        (SELECT count(*) FROM public.game_server_nodes
          WHERE enabled AND gpu)                                                         AS gpu_nodes,
        (SELECT count(*) FROM public.game_server_nodes
          WHERE pin_build_id IS NOT NULL OR pin_plugin_version IS NOT NULL)              AS nodes_pinned,
        (SELECT count(*) FROM public.game_server_nodes
          WHERE enabled AND gpu AND gpu_demos_enabled)                                               AS gpu_demo_nodes,
        (SELECT count(*) FROM public.game_server_nodes
          WHERE enabled AND gpu AND gpu_rendering_enabled)                                           AS gpu_render_nodes,
        (SELECT count(*) FROM public.game_server_nodes
          WHERE enabled AND gpu AND gpu_streaming_enabled)                                           AS gpu_stream_nodes,

        (SELECT count(*) FROM public.servers
          WHERE ${TelemetryService.RealServer})                                          AS servers_total,
        (SELECT count(*) FROM public.servers
          WHERE ${TelemetryService.RealServer} AND enabled)                              AS servers_enabled,
        (SELECT count(*) FROM public.servers WHERE is_dedicated)                         AS servers_dedicated,
        (SELECT count(*) FROM public.servers
          WHERE ${TelemetryService.RealServer} AND type <> 'Ranked')                     AS servers_public,

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

        -- Decomposes matches_ran. A match only carries started_at once it has
        -- gone live, so 'Canceled' here is a match abandoned mid-series rather
        -- than one called off before it ever ran.
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.nativeMatch()}
            AND status IN ('Finished', 'Forfeit', 'Tie', 'Surrendered'))                 AS matches_finished,
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.nativeMatch()}
            AND status IN ('Canceled'))                                                  AS matches_abandoned,
        (SELECT count(*) FROM public.matches
          WHERE ${TelemetryService.nativeMatch()} AND status = 'Live')                    AS matches_live,

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
        (SELECT count(*) FROM public.players WHERE discord_id IS NOT NULL)               AS players_discord,
        (SELECT count(*) FROM public.players WHERE name_registered)                      AS players_name_registered,
        -- Stats land per map from live round events and from parsed demos, so
        -- this is everyone who played rather than everyone who was rostered.
        (SELECT count(DISTINCT steam_id) FROM public.player_match_map_stats)             AS players_played,
        -- Rows, not distinct players: the pair is what separates a busy
        -- community from a handful of people playing a lot.
        (SELECT count(*) FROM public.player_match_map_stats)                             AS player_appearances,
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
        (SELECT count(*) FROM public.tournaments WHERE status = 'Finished')              AS tournaments_finished,
        (SELECT count(*) FROM public.tournament_teams)                                   AS tournament_teams,
        (SELECT count(*) FROM public.league_seasons)                                     AS league_seasons,
        (SELECT count(*) FROM public.league_seasons WHERE status = 'Finished')           AS league_seasons_finished,
        -- Not league_divisions: the four tiers are seeded by migration, so
        -- every install reports the same four whether or not it runs a league.
        (SELECT count(*) FROM public.league_team_seasons)                                AS league_registrations,
        (SELECT count(*) FROM public.league_teams)                                       AS league_teams,
        (SELECT count(*) FROM public.event_teams)                                        AS event_teams,
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
        (SELECT count(*) FROM public.gamedata_signature_validations)                     AS gamedata_validations,
        (SELECT count(*) FROM public.match_demo_sessions)                                AS demo_sessions,
        (SELECT count(*) FROM public.match_streams)                                      AS match_streams,
        (SELECT count(*) FROM public.push_subscriptions)                                 AS push_subscriptions,
        (SELECT count(*) FROM public.player_steam_bot_friend)                            AS steam_presence_friends
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
}

type TelemetryCounts = {
  installed_at: string | null;
} & Record<string, number>;
