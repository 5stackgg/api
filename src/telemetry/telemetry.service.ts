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
  TelemetryPlugins,
  TelemetryUtility,
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
    utility_library: {
      setting: "public.utility_library_enabled",
      defaultEnabled: true,
    },
    utility_practice: {
      setting: "public.utility_practice_enabled",
      defaultEnabled: true,
    },
    // Off unless an operator opened it: the seeder writes lineups nobody threw
    // on this panel.
    utility_import: {
      setting: "public.utility_import_enabled",
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

  // Feature key -> the collect count that measures it. Static, rather than
  // built inside buildFeatures, so the fleet page can also list a feature no
  // panel has reported yet (see getFeatureAdoption) instead of dropping it
  // until the fleet has updated.
  //
  // demo_playback and live_streaming deliberately have no count. The only rows
  // that record either -- match_demo_sessions, match_streams -- are deleted
  // when the session ends, so counting them reports how many people happen to
  // be watching during the collect, not how much the panel has ever used it. A
  // panel that has served ten thousand playbacks would report zero. Both are in
  // DetectedFeatures, so their adoption comes from `enabled` (a GPU node
  // carrying the workload) and the null count reads as "not measured" rather
  // than as "nobody uses it".
  private static readonly FeatureUsage: Record<string, string> = {
    tournaments: "tournaments",
    leagues: "league_seasons",
    seasons: "seasons",
    events: "events",
    news: "news_articles",
    highlights: "match_clips",
    clip_renders: "clip_render_jobs",
    system_alerts: "system_alerts",
    awards: "award_recipients",
    scrims: "scrim_requests",
    matchmaking: "lobbies",
    custom_pages: "custom_pages",
    external_matches: "matches_external",
    faceit_import: "matches_faceit",
    draft_games: "draft_games",
    demos: "demos",
    sanctions: "sanctions",
    api_keys: "api_keys",
    gamedata_validations: "gamedata_validations",
    push_notifications: "push_subscriptions",
    utility_library: "utility_lineups",
    utility_practice: "utility_sessions",
    // Lineups an operator bulk-loaded rather than anybody throwing them, which
    // is the only thing the switch controls.
    utility_import: "utility_imported",
    game_server_nodes: "nodes_total",
    version_pinning: "nodes_pinned",
    discord_bot: "players_discord",
    steam_presence: "steam_presence_friends",
    player_name_registration: "players_name_registered",
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
    private readonly configService: ConfigService,
    private readonly postgres: PostgresService,
    private readonly systemService: SystemService,
    private readonly cache: CacheService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
    this.redis = this.redisManagerService.getConnection();
  }

  // The panel the whole fleet reports to. It is a panel like any other and its
  // counts belong in the fleet, but it is the one install that cannot get them
  // there over the wire.
  private isReceivingPanel() {
    return this.appConfig.webDomain.includes("://5stack.gg");
  }

  async send() {
    let payload: TelemetryPayload;

    try {
      payload = await this.collect();
    } catch (error) {
      this.logger.warn("unable to collect telemetry", error);
      return;
    }

    // Handed to the same ingest every other panel goes through -- sanitize and
    // all -- rather than POSTed to itself. A loopback request would land on the
    // public route's per-address throttle and arrive with no country header,
    // and the flagship is exactly the install a dropped report is worst on.
    if (this.isReceivingPanel()) {
      await this.record(null, null, payload);
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
    const [
      installId,
      settings,
      counts,
      byType,
      bySource,
      utilityByType,
      utilityBySource,
    ] = await Promise.all([
      this.getInstallId(),
      this.getSettings(),
      this.getCounts(),
      this.getMatchesByType(),
      this.getMatchesBySource(),
      this.getUtilityBy("utility_type"),
      this.getUtilityBy("origin_source"),
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
      plugins: {
        requested: counts.plugins_requested,
        by_slug: await this.pluginInstallsBySlug(),
        manual: counts.plugins_manual,
        modes: counts.game_modes,
        modes_enabled: counts.game_modes_enabled,
        modes_unranked: counts.game_modes_unranked,
      },
      utility: {
        lineups: counts.utility_lineups,
        archived: counts.utility_archived,
        week: counts.utility_lineups_week,
        month: counts.utility_lineups_month,
        public: counts.utility_public,
        team: counts.utility_team,
        private: counts.utility_private,
        authors: counts.utility_authors,
        maps: counts.utility_maps,
        verified: counts.utility_verified,
        pending_review: counts.utility_pending_review,
        previews: counts.utility_previews,
        favorites: counts.utility_favorites,
        votes: counts.utility_votes,
        collections: counts.utility_collections,
        playbooks: counts.utility_playbooks,
        playbook_steps: counts.utility_playbook_steps,
        by_type: utilityByType,
        by_source: utilityBySource,
        sessions: counts.utility_sessions,
        sessions_week: counts.utility_sessions_week,
        sessions_month: counts.utility_sessions_month,
        sessions_failed: counts.utility_sessions_failed,
        hosts: counts.utility_hosts,
        practicing: counts.utility_practicing,
        attempts: counts.utility_attempts,
        successes: counts.utility_successes,
        mastered: counts.utility_mastered,
        demos_mined: counts.utility_demos_mined,
        demo_throws: counts.utility_demo_throws,
        meta_lineups: counts.utility_meta_lineups,
        drift_scans: counts.utility_drift_scans,
        drift_flagged: counts.utility_drift_flagged,
        repairs: counts.utility_repairs,
      },
      features: this.buildFeatures(settings, counts),
    };
  }

  // Named counts, unlike everything else in the payload. Ranking the catalog by
  // what operators actually run is the only reason this section exists, and a
  // total without slugs cannot do it. Only catalog plugins appear: a hand-placed
  // folder is counted under `manual` instead, since its name means nothing to
  // anyone else.
  private async pluginInstallsBySlug(): Promise<Record<string, number>> {
    const rows = await this.postgres.query<
      Array<{ plugin_slug: string; nodes: number }>
    >(
      `SELECT n.plugin_slug, count(DISTINCT n.game_server_node_id)::int AS nodes
         FROM public.game_server_node_plugins n
        WHERE n.source = 'managed'
          AND n.detected = true
          AND EXISTS (
            SELECT 1 FROM public.game_plugins p WHERE p.slug = n.plugin_slug
          )
        GROUP BY n.plugin_slug`,
    );

    return Object.fromEntries(rows.map((row) => [row.plugin_slug, row.nodes]));
  }

  async record(ip: string | null, country: string | null, data: unknown) {
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
  async getOnlineSystemsCount(includeSelf = true): Promise<number> {
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

    // The receiving panel keeps its own heartbeat under its install id like
    // everyone else, so filtering it out of the totals has to take it out of
    // the badge too -- otherwise the filtered page is one panel short of its
    // own online count.
    if (!includeSelf) {
      const installId = await this.selfInstallId(false);

      if (installId) {
        seen.delete(`online_system:${installId}`);
      }
    }

    return seen.size;
  }

  // The nav badge polls this action every minute for `online` alone, and a
  // Hasura action handler cannot see the GraphQL selection set — so the
  // aggregates are cached and only the Redis-backed online count runs per call.
  // Panels report hourly, so nothing here goes stale within the TTL.
  async getFleetStats(includeSelf = true) {
    const self = await this.selfInstallId(includeSelf);

    const aggregates = await this.cache.remember(
      // Versioned: a cached blob from the previous shape would leave the page
      // missing every field added since, for as long as the TTL lasts. Keyed on
      // the filter too, so the two views cannot serve each other's numbers.
      `telemetry:fleet:v4:${includeSelf ? "all" : "others"}`,
      async () => {
        const [
          installs,
          totals,
          features,
          growth,
          activity,
          composition,
          distribution,
          utility,
        ] = await Promise.all([
          this.getInstallCounts(self),
          this.getFleetTotals(self),
          this.getFeatureAdoption(self),
          this.getInstallGrowth(self),
          this.getFleetActivity(self),
          this.getMatchComposition(self),
          this.getFleetDistribution(self),
          this.getUtilityComposition(self),
        ]);

        return {
          installs,
          totals,
          features,
          growth,
          activity,
          ...composition,
          ...distribution,
          ...utility,
        };
      },
      300,
    );

    return {
      online: await this.getOnlineSystemsCount(includeSelf),
      ...aggregates,
    };
  }

  // 5stack.gg reports like every other panel now, and it is far and away the
  // largest install on the page -- big enough that its history reads as the
  // fleet's rather than as one panel's. This is what the page's filter turns
  // off, and every aggregate takes it so a filtered view is filtered all the
  // way down instead of in the headline alone.
  //
  // Null when the flagship is being counted like everything else. On any panel
  // but the receiving one this excludes an install id that is not in the table
  // to begin with, which is the no-op it should be.
  private async selfInstallId(includeSelf: boolean) {
    if (includeSelf) {
      return null;
    }

    const installId = await this.getInstallId();

    // The id is interpolated rather than bound: the aggregates take no
    // parameters and every one of them would need its own placeholder number.
    // Safe because it is a uuid this panel generated in its own settings row,
    // and the shape is checked here rather than trusted.
    return TelemetryService.Uuid.test(installId) ? installId : null;
  }

  private static readonly Uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // `true` rather than an empty string so callers can always append it with
  // AND, including the queries that have nothing else to filter on. The column
  // is spelled out per call site because half of these queries alias the table.
  private static excluding(self: string | null, column = "install_id") {
    return self ? `${column} <> '${self}'::uuid` : "true";
  }

  private async getInstallCounts(self: string | null) {
    const [row] = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         count(*)                                                                   AS total,
         count(*) FILTER (WHERE last_seen_at >= now() - interval '24 hours')        AS active24h,
         count(*) FILTER (WHERE last_seen_at >= now() - interval '7 days')          AS active7d,
         count(*) FILTER (WHERE last_seen_at >= now() - interval '30 days')         AS active30d,
         count(*) FILTER (WHERE first_seen_at >= now() - interval '30 days')        AS new30d,
         count(*) FILTER (WHERE first_seen_at < now() - interval '180 days'
                            AND last_seen_at >= now() - interval '7 days')          AS retained180d
       FROM public.telemetry_installs
       WHERE ${TelemetryService.excluding(self)}`,
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

  // Summed across the latest payload of every install that ever reported one.
  //
  // A panel that has gone dark still played the matches it played, so nothing
  // cumulative is held to a window -- dropping a dark install took its whole
  // all-time counter out of the fleet, which is why the totals read far below
  // what the panels behind them have actually run.
  //
  // Only two kinds of column keep the window, via a per-column FILTER:
  // point-in-time state, because a node torn down a year ago is not capacity
  // and a build nobody runs is not the fleet; and the rolling windows, because
  // a dark panel's "last 7 days" ended whenever it stopped reporting and
  // summing it into today's would date the number to nothing.
  //
  // So the two totals are over two different denominators, and the page has to
  // say which: `panels` counts the ones still checking in, and installs.total
  // (getInstallCounts) is the set every cumulative number is summed over.
  private static readonly RecentPanel =
    "last_seen_at >= now() - interval '30 days'";

  private async getFleetTotals(self: string | null) {
    const recent = `FILTER (WHERE ${TelemetryService.RecentPanel})`;

    const [row] = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         count(*) ${recent}                                                   AS panels,
         coalesce(sum((payload->'nodes'->>'total')::numeric) ${recent}, 0)    AS "gameServerNodes",
         coalesce(sum((payload->'nodes'->>'enabled')::numeric) ${recent}, 0)  AS "gameServerNodesEnabled",
         coalesce(sum((payload->'nodes'->>'online')::numeric) ${recent}, 0)   AS "gameServerNodesOnline",
         -- Regions are named per panel, so this is how many each has stood up
         -- rather than how many distinct regions the fleet covers.
         coalesce(sum((payload->'nodes'->>'regions')::numeric) ${recent}, 0)  AS regions,
         coalesce(sum((payload->'nodes'->>'gpu')::numeric) ${recent}, 0)      AS "gpuNodes",
         coalesce(sum((payload->'servers'->>'total')::numeric) ${recent}, 0)  AS servers,
         coalesce(sum((payload->'servers'->>'enabled')::numeric) ${recent}, 0) AS "serversEnabled",
         coalesce(sum((payload->'servers'->>'dedicated')::numeric) ${recent}, 0) AS "dedicatedServers",
         coalesce(sum((payload->'servers'->>'public')::numeric) ${recent}, 0) AS "publicServers",
         coalesce(sum((payload->'matches'->>'total')::numeric), 0)            AS matches,
         coalesce(sum((payload->'matches'->>'created')::numeric), 0)          AS "matchesCreated",
         coalesce(sum((payload->'matches'->>'week')::numeric) ${recent}, 0)   AS "matchesWeek",
         coalesce(sum((payload->'matches'->>'month')::numeric) ${recent}, 0)  AS "matchesMonth",
         coalesce(sum((payload->'matches'->>'year')::numeric) ${recent}, 0)   AS "matchesYear",
         -- A field added after a panel's build reports nothing, and summing
         -- that to zero reads as "no match ever finished". Count who actually
         -- supplied it so the page can say "not reported yet" instead.
         count(*) FILTER (WHERE payload->'matches'->>'finished' IS NOT NULL) AS "outcomesReported",
         coalesce(sum((payload->'matches'->>'finished')::numeric), 0)         AS "matchesFinished",
         coalesce(sum((payload->'matches'->>'abandoned')::numeric), 0)        AS "matchesAbandoned",
         -- Live Now is the one match column that is state rather than history.
         coalesce(sum((payload->'matches'->>'live')::numeric) ${recent}, 0)   AS "matchesLive",
         coalesce(sum((payload->'matches'->>'tournament')::numeric), 0)       AS "matchesTournament",
         coalesce(sum((payload->'matches'->>'league')::numeric), 0)           AS "matchesLeague",
         coalesce(sum((payload->'matches'->>'scrim')::numeric), 0)            AS "matchesScrim",
         coalesce(sum((payload->'matches'->'external'->>'total')::numeric), 0) AS "matchesImported",
         coalesce(sum((payload->'matches'->'external'->>'month')::numeric) ${recent}, 0) AS "matchesImportedMonth",
         coalesce(sum((payload->'matches'->'external'->>'year')::numeric) ${recent}, 0)  AS "matchesImportedYear",
         coalesce(sum((payload->'matches'->>'maps_played')::numeric), 0)      AS "mapsPlayed",
         coalesce(sum((payload->'players'->>'known')::numeric), 0)            AS "playersKnown",
         coalesce(sum((payload->'players'->>'registered')::numeric), 0)       AS "playersRegistered",
         coalesce(sum((payload->'players'->>'played')::numeric), 0)           AS "playersPlayed",
         count(*) FILTER (
           WHERE payload->'players'->>'appearances' IS NOT NULL
         )                                                                    AS "appearancesReported",
         coalesce(sum((payload->'players'->>'appearances')::numeric), 0)      AS "playerAppearances",
         coalesce(sum((payload->'players'->>'active_7d')::numeric) ${recent}, 0)  AS "playersActive7d",
         coalesce(sum((payload->'players'->>'active_30d')::numeric) ${recent}, 0) AS "playersActive30d",
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
         coalesce(sum((payload->'competition'->>'event_teams')::numeric), 0)           AS "eventTeams",

         -- Same "reported vs zero" split the match outcomes use: a panel too old
         -- to send this section is not a panel running no plugins.
         -- Windowed with the rest of the point-in-time state: what a panel had
         -- on disk before it went dark is not what the fleet runs today, and
         -- the directory's whole job is to rank what anybody is running now.
         count(*) FILTER (
           WHERE jsonb_typeof(payload->'plugins') = 'object'
             AND ${TelemetryService.RecentPanel}
         )                                                                             AS "pluginsReported",
         coalesce(sum((payload->'plugins'->>'requested')::numeric) ${recent}, 0)        AS "pluginsRequested",
         coalesce(sum((payload->'plugins'->>'manual')::numeric) ${recent}, 0)           AS "pluginsManual",
         coalesce(sum((payload->'plugins'->>'modes')::numeric) ${recent}, 0)            AS "gameModes",
         coalesce(sum((payload->'plugins'->>'modes_enabled')::numeric) ${recent}, 0)    AS "gameModesEnabled",
         coalesce(sum((payload->'plugins'->>'modes_unranked')::numeric) ${recent}, 0)   AS "gameModesUnranked",
         -- Installs per plugin across the fleet, and how many separate panels
         -- run each. The panel count is the honest popularity signal: one
         -- operator with forty nodes is not forty operators.
         (
           SELECT coalesce(jsonb_object_agg(slug, counts), '{}'::jsonb)
             FROM (
               SELECT entry.key AS slug,
                      jsonb_build_object(
                        'nodes', sum((entry.value)::numeric),
                        'panels', count(*)
                      ) AS counts
                 FROM public.telemetry_installs i
                 CROSS JOIN LATERAL jsonb_each_text(
                   coalesce(i.payload->'plugins'->'by_slug', '{}'::jsonb)
                 ) AS entry
                WHERE i.last_seen_at >= now() - interval '30 days'
                  AND ${TelemetryService.excluding(self, "i.install_id")}
                GROUP BY entry.key
             ) ranked
         )                                                                             AS "pluginsBySlug"
       FROM public.telemetry_installs
       WHERE payload ? 'matches'
         AND ${TelemetryService.excluding(self)}`,
    );

    const totals = TelemetryService.toIntegers(row, [
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
      "pluginsReported",
      "pluginsRequested",
      "pluginsManual",
      "gameModes",
      "gameModesEnabled",
      "gameModesUnranked",
    ]);

    return {
      ...totals,
      // jsonb rather than a count, so it is not one of the coerced keys above
      // and toIntegers would otherwise drop it.
      pluginsBySlug: (row?.pluginsBySlug ?? {}) as Record<string, unknown>,
    };
  }

  // Both breakdowns live in the payload already; nothing read them before, so
  // the page could say how many matches ran but never what kind they were.
  private async getMatchComposition(self: string | null) {
    const [types, sources] = await Promise.all([
      this.sumCountMap("matches", "by_type", self),
      this.sumCountMap("matches", "by_source", self),
    ]);

    return {
      matchTypes: types.map(({ name, total }) => ({
        type: name,
        matches: total,
      })),
      matchSources: sources.map(({ name, total }) => ({
        source: name,
        matches: total,
      })),
    };
  }

  // The library section of the payload, summed the same way and over the same
  // window as the fleet totals. Kept out of getFleetTotals because that query
  // is already one statement per panel column, and this whole block is absent
  // from most of the fleet until panels update.
  private async getUtilityComposition(self: string | null) {
    const [totals, types, sources] = await Promise.all([
      this.getUtilityTotals(self),
      this.sumCountMap("utility", "by_type", self),
      this.sumCountMap("utility", "by_source", self),
    ]);

    return {
      utility: totals,
      utilityTypes: types.map(({ name, total }) => ({
        type: name,
        lineups: total,
      })),
      utilitySources: sources.map(({ name, total }) => ({
        source: name,
        lineups: total,
      })),
    };
  }

  private static readonly UtilityFields = [
    "lineups",
    "archived",
    "week",
    "month",
    "public",
    "team",
    "private",
    "authors",
    "maps",
    "verified",
    "pending_review",
    "previews",
    "favorites",
    "votes",
    "collections",
    "playbooks",
    "playbook_steps",
    "sessions",
    "sessions_week",
    "sessions_month",
    "sessions_failed",
    "hosts",
    "practicing",
    "attempts",
    "successes",
    "mastered",
    "demos_mined",
    "demo_throws",
    "meta_lineups",
    "drift_scans",
    "drift_flagged",
    "repairs",
  ] as const;

  // Rolling windows rather than all-time counts, so they are the only utility
  // fields a dark panel cannot contribute to -- see getFleetTotals.
  private static readonly UtilityWindowFields = new Set(["week", "month"]);

  private async getUtilityTotals(self: string | null) {
    // Every field is summed the same way, so the column list is generated from
    // the payload's own field names rather than written out twice.
    const sums = TelemetryService.UtilityFields.map((field) => {
      const filter = TelemetryService.UtilityWindowFields.has(field)
        ? ` FILTER (WHERE ${TelemetryService.RecentPanel})`
        : "";

      return `coalesce(sum((payload->'utility'->>'${field}')::numeric)${filter}, 0) AS "${TelemetryService.camel(field)}"`;
    }).join(",\n         ");

    const [row] = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         count(*) FILTER (WHERE jsonb_typeof(payload->'utility') = 'object') AS reported,
         ${sums}
       FROM public.telemetry_installs
       WHERE ${TelemetryService.excluding(self)}`,
    );

    return TelemetryService.toIntegers(row, [
      "reported",
      ...TelemetryService.UtilityFields.map(TelemetryService.camel),
    ]);
  }

  private static camel(field: string) {
    return field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  private async sumCountMap(
    section: string,
    field: string,
    self: string | null,
  ) {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         e.key                                          AS name,
         coalesce(sum((e.value#>>'{}')::numeric), 0)    AS total
       FROM public.telemetry_installs i,
            LATERAL jsonb_each(
              coalesce(i.payload->'${section}'->'${field}', '{}'::jsonb)
            ) e(key, value)
       -- Unwindowed, like the totals these break down: a mix that drops the
       -- dark panels no longer adds up to the number it sits under.
       WHERE jsonb_typeof(e.value) = 'number'
         AND ${TelemetryService.excluding(self, "i.install_id")}
       GROUP BY e.key
       ORDER BY total DESC, e.key ASC`,
    );

    return rows.map((row) => ({
      name: row.name,
      ...TelemetryService.toIntegers(row, ["total"]),
    }));
  }

  // Version and country are promoted to columns on arrival; the plugin runtime
  // only ever lands in the payload, so it has to be read back out of the json.
  private async getFleetDistribution(self: string | null) {
    const [versions, runtimes, countries] = await Promise.all([
      this.getVersionAdoption(self),
      this.countInstallsBy("payload->>'plugin_runtime'", self),
      this.countInstallsBy("country", self),
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
  private async getVersionAdoption(self: string | null) {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `WITH seen AS (
         SELECT
           payload->>'panel_version'                       AS version,
           min(day)                                        AS since
         FROM public.telemetry_snapshots
         WHERE coalesce(payload->>'panel_version', '') <> ''
           AND ${TelemetryService.excluding(self)}
         GROUP BY 1
       ),
       -- A build nobody is running any more is history, not fleet state.
       live AS (
         SELECT s.version, s.since, count(i.install_id) AS installs
         FROM seen s
         JOIN public.telemetry_installs i
           ON i.panel_version = s.version
          AND i.last_seen_at >= now() - interval '30 days'
          AND ${TelemetryService.excluding(self, "i.install_id")}
         GROUP BY 1, 2
       )
       -- Ranked after the dead builds are dropped, not before. Ranking over
       -- every version ever seen and filtering afterwards leaves the ranks
       -- sparse and often starting above 1 -- one dev box that reported a
       -- one-off build and went dark holds rank 1 for good -- and the page
       -- reads rank 1 and 2 as the current and previous build.
       SELECT
         version                                AS version,
         row_number() OVER (ORDER BY since DESC, version ASC) AS rank,
         to_char(since, 'YYYY-MM-DD')           AS since,
         installs                               AS installs
       FROM live
       ORDER BY rank ASC
       LIMIT 25`,
    );

    return rows.map((row) => ({
      version: row.version,
      since: row.since,
      ...TelemetryService.toIntegers(row, ["rank", "installs"]),
    }));
  }

  private async countInstallsBy(expression: string, self: string | null) {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT ${expression} AS name, count(*) AS installs
       FROM public.telemetry_installs
       WHERE last_seen_at >= now() - interval '30 days'
         AND ${TelemetryService.excluding(self)}
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

  private async getFeatureAdoption(self: string | null) {
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
         AND ${TelemetryService.excluding(self, "i.install_id")}
       GROUP BY f.key
       ORDER BY total DESC, f.key ASC`,
    );

    const adoption = rows.map((row) => {
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

    // A feature added after the builds currently in the fleet has no row here
    // at all, and leaving it out reads as a feature that does not exist rather
    // than as one nothing has reported yet. Emit it with nothing reported --
    // `reporting: 0` is what the page reads to say so -- so a switch shows up
    // on the fleet page the moment this build knows about it.
    const reported = new Set(adoption.map((feature) => feature.key));

    for (const key of TelemetryService.knownFeatures()) {
      if (reported.has(key)) {
        continue;
      }

      adoption.push({
        key,
        kind: TelemetryService.featureKind(key, 0),
        enabled: 0,
        flagged: 0,
        reporting: 0,
        counted: 0,
        installsUsing: 0,
        total: 0,
      });
    }

    // Same order the query asked for, applied again now that the unreported
    // ones have been folded in.
    return adoption.sort(
      (a, b) => b.total - a.total || a.key.localeCompare(b.key),
    );
  }

  // Every feature this build can report, whether or not a panel in the fleet
  // has sent it yet.
  private static knownFeatures() {
    return new Set([
      ...Object.keys(TelemetryService.FeatureFlags),
      ...Object.keys(TelemetryService.FeatureUsage),
      ...TelemetryService.DetectedFeatures,
    ]);
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

  private async getInstallGrowth(self: string | null) {
    const rows = await this.postgres.query<Array<Record<string, string>>>(
      `SELECT
         to_char(date_trunc('month', first_seen_at), 'YYYY-MM') AS month,
         count(*)                                               AS installs
       FROM public.telemetry_installs
       WHERE ${TelemetryService.excluding(self)}
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
  private async getFleetActivity(self: string | null) {
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
           AND ${TelemetryService.excluding(self)}
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

  private async persist(payload: TelemetryPayload, country: string | null) {
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
      plugins: TelemetryService.sanitizePlugins(body.plugins, int),
      utility: TelemetryService.sanitizeUtility(body.utility, int),
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

  // Same null-in-null-out rule as competition. by_slug is capped and its keys
  // are shape-checked: this is the one section where a panel sends free-form
  // strings, and they end up rendered on the fleet page.
  private static sanitizePlugins(
    value: unknown,
    int: (value: unknown) => number,
  ): TelemetryPlugins | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const plugins = value as Record<string, any>;
    const bySlug: Record<string, number> = {};
    const source = plugins.by_slug;

    if (source && typeof source === "object" && !Array.isArray(source)) {
      for (const [slug, count] of Object.entries(source).slice(0, 200)) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
          continue;
        }

        bySlug[slug] = int(count);
      }
    }

    return {
      requested: int(plugins.requested),
      by_slug: bySlug,
      manual: int(plugins.manual),
      modes: int(plugins.modes),
      modes_enabled: int(plugins.modes_enabled),
      modes_unranked: int(plugins.modes_unranked),
    };
  }

  // Same null-in-null-out rule as competition and plugins.
  private static sanitizeUtility(
    value: unknown,
    int: (value: unknown) => number,
  ): TelemetryUtility | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const utility = value as Record<string, any>;

    return {
      lineups: int(utility.lineups),
      archived: int(utility.archived),
      week: int(utility.week),
      month: int(utility.month),
      public: int(utility.public),
      team: int(utility.team),
      private: int(utility.private),
      authors: int(utility.authors),
      maps: int(utility.maps),
      verified: int(utility.verified),
      pending_review: int(utility.pending_review),
      previews: int(utility.previews),
      favorites: int(utility.favorites),
      votes: int(utility.votes),
      collections: int(utility.collections),
      playbooks: int(utility.playbooks),
      playbook_steps: int(utility.playbook_steps),
      by_type: TelemetryService.sanitizeCountMap(utility.by_type, int),
      by_source: TelemetryService.sanitizeCountMap(utility.by_source, int),
      sessions: int(utility.sessions),
      sessions_week: int(utility.sessions_week),
      sessions_month: int(utility.sessions_month),
      sessions_failed: int(utility.sessions_failed),
      hosts: int(utility.hosts),
      practicing: int(utility.practicing),
      attempts: int(utility.attempts),
      successes: int(utility.successes),
      mastered: int(utility.mastered),
      demos_mined: int(utility.demos_mined),
      demo_throws: int(utility.demo_throws),
      meta_lineups: int(utility.meta_lineups),
      drift_scans: int(utility.drift_scans),
      drift_flagged: int(utility.drift_flagged),
      repairs: int(utility.repairs),
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
    const usage: Record<string, number> = {};

    for (const [key, count] of Object.entries(TelemetryService.FeatureUsage)) {
      usage[key] = counts[count];
    }

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

  // Live lineups only, so both breakdowns decompose the same `lineups` count
  // the rest of the section reports.
  private async getUtilityBy(
    column: "utility_type" | "origin_source",
  ): Promise<Record<string, number>> {
    const rows = await this.collectQuery<Array<Record<string, string>>>(
      `SELECT ${column} AS name, count(*) AS count
         FROM public.utility_lineups
        WHERE archived_at IS NULL
        GROUP BY ${column}`,
    );

    return TelemetryService.toCountMap(rows, "name");
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
        -- Parenthesised: without it, AND binding tighter than OR reads as
        -- (enabled AND pinned build) OR pinned plugin, and a disabled node
        -- with a pinned plugin version counts anyway.
        (SELECT count(*) FROM public.game_server_nodes
          WHERE enabled
            AND (pin_build_id IS NOT NULL OR pin_plugin_version IS NOT NULL))            AS nodes_pinned,

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
        (SELECT count(*) FROM public.push_subscriptions)                                 AS push_subscriptions,
        (SELECT count(*) FROM public.player_steam_bot_friend)                            AS steam_presence_friends,

        -- Archived is excluded everywhere but its own count: an archived lineup
        -- is still visible to its author and to nobody else, so counting it in
        -- the library overstates what anyone can actually browse.
        (SELECT count(*) FROM public.utility_lineups WHERE archived_at IS NULL)          AS utility_lineups,
        (SELECT count(*) FROM public.utility_lineups WHERE archived_at IS NOT NULL)      AS utility_archived,
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL AND created_at >= now() - interval '7 days')         AS utility_lineups_week,
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL AND created_at >= now() - interval '30 days')        AS utility_lineups_month,
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL AND visibility = 'Public')                           AS utility_public,
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL AND visibility = 'Team')                             AS utility_team,
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL AND visibility = 'Private')                          AS utility_private,
        (SELECT count(DISTINCT author_steam_id) FROM public.utility_lineups
          WHERE archived_at IS NULL)                                                     AS utility_authors,
        (SELECT count(DISTINCT map_name) FROM public.utility_lineups
          WHERE archived_at IS NULL)                                                     AS utility_maps,
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL AND verified_at IS NOT NULL)                         AS utility_verified,
        -- The moderator queue, spelled exactly as utility_lineups_public_queue_idx
        -- spells it. Approval is what clears public_requested_at (the trigger
        -- stamps the review and nulls the request), so "requested and not yet
        -- public" is the whole of it -- reading public_reviewed_at instead would
        -- count a lineup that was reviewed once and asked again as settled.
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL
            AND public_requested_at IS NOT NULL
            AND visibility <> 'Public')                                                  AS utility_pending_review,
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL AND preview_rendered_at IS NOT NULL)                 AS utility_previews,
        (SELECT count(*) FROM public.utility_lineups
          WHERE archived_at IS NULL AND origin_source = 'import')                        AS utility_imported,
        (SELECT count(*) FROM public.utility_lineup_favorites)                           AS utility_favorites,
        (SELECT count(*) FROM public.utility_lineup_votes)                               AS utility_votes,
        (SELECT count(*) FROM public.utility_collections)                                AS utility_collections,
        (SELECT count(*) FROM public.utility_playbooks)                                  AS utility_playbooks,
        (SELECT count(*) FROM public.utility_playbook_steps)                             AS utility_playbook_steps,

        -- A render books a practice server exactly as a player does and is
        -- hosted by whoever approved the lineup, so counting those rows reports
        -- the clip pipeline's server bookings as people practising. The
        -- render pipeline is measured by utility_previews instead.
        (SELECT count(*) FROM public.utility_practice_sessions
          WHERE NOT is_render)                                                           AS utility_sessions,
        (SELECT count(*) FROM public.utility_practice_sessions
          WHERE NOT is_render AND created_at >= now() - interval '7 days')               AS utility_sessions_week,
        (SELECT count(*) FROM public.utility_practice_sessions
          WHERE NOT is_render AND created_at >= now() - interval '30 days')              AS utility_sessions_month,
        (SELECT count(*) FROM public.utility_practice_sessions
          WHERE NOT is_render AND status = 'Failed')                                     AS utility_sessions_failed,
        (SELECT count(DISTINCT host_steam_id) FROM public.utility_practice_sessions
          WHERE NOT is_render)                                                           AS utility_hosts,
        -- The practice plugin scores every throw and rolls it into this row, so
        -- attempts is grenades thrown at a lineup rather than sessions started.
        (SELECT count(DISTINCT steam_id) FROM public.utility_lineup_progress)            AS utility_practicing,
        (SELECT coalesce(sum(attempts), 0) FROM public.utility_lineup_progress)          AS utility_attempts,
        (SELECT coalesce(sum(successes), 0) FROM public.utility_lineup_progress)         AS utility_successes,
        (SELECT count(*) FROM public.utility_lineup_progress
          WHERE mastered_at IS NOT NULL)                                                 AS utility_mastered,

        (SELECT count(*) FROM public.utility_demo_mines)                                 AS utility_demos_mined,
        (SELECT count(*) FROM public.utility_demo_throws)                                AS utility_demo_throws,
        (SELECT count(*) FROM public.utility_meta_lineups)                               AS utility_meta_lineups,
        (SELECT count(*) FROM public.utility_drift_scans)                                AS utility_drift_scans,
        -- Distinct lineups, not verdict rows: every scan re-judges the whole
        -- map, so summing verdicts counts one unlucky smoke once per patch.
        (SELECT count(DISTINCT utility_lineup_id) FROM public.utility_drift_results
          WHERE verdict IN ('moved', 'broken'))                                          AS utility_drift_flagged,
        (SELECT count(*) FROM public.utility_lineup_repairs
          WHERE status = 'Repaired')                                                     AS utility_repairs,

        (SELECT count(*) FROM public.game_plugin_installs WHERE enabled)                 AS plugins_requested,
        -- source = 'manual' is a folder somebody dropped on a node by hand. It
        -- has no catalog slug, so it can only ever be a count.
        (SELECT count(*) FROM public.game_server_node_plugins WHERE source = 'manual')   AS plugins_manual,
        (SELECT count(*) FROM public.game_modes WHERE archived_at IS NULL)               AS game_modes,
        (SELECT count(*) FROM public.game_modes
          WHERE archived_at IS NULL AND enabled)                                         AS game_modes_enabled,
        -- Every custom mode is unranked (match_ranking_for_options), so this
        -- is the modes draft lobbies will not offer. The key keeps its old name
        -- because payloads already recorded across the fleet sum under it.
        (SELECT count(*) FROM public.game_modes
          WHERE archived_at IS NULL AND competitive_safe = false)                        AS game_modes_unranked
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
