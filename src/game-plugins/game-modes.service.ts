import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { PluginRuntimeService } from "../plugin-runtime/plugin-runtime.service";
import { PluginRuntime } from "../configs/types/GameServersConfig";

export type ResolvedGameMode = {
  id: string;
  slug: string;
  name: string;
  cfg: string | null;
  extraGameParams: string | null;
  // How many players a side this mode is built for; null means it inherits the
  // match type's count.
  playersPerTeam: number | null;
  enabledPlugins: string;
  pluginConfigs: string | null;
  missingRequired: Array<string>;
  disableServerGuidelines: boolean;
};

// Which kind of match is about to run. An install says which of the three it
// loads on by itself, so this is what that answer is looked up against.
//
// "ranked" means the match counts toward ranking -- competitive play -- not
// that matchmaking created it. A draft lobby playing for Elo is as ranked as a
// queued match, and an operator keeping a cosmetics plugin out of competitive
// means both. "custom" is what is left once competitive and tournament play
// are accounted for.
export type MatchScope = "ranked" | "tournaments" | "custom";

// Which node's disk decides the answer, and which framework it is running.
// A null node means "any node has it", which is only ever right when nothing is
// about to boot -- a preview.
type PluginScope = {
  nodeId: string | null;
  runtime: PluginRuntime;
  // Absent on a preview, where there is no match to resolve against.
  match?: MatchScope;
};

type ModeRow = {
  id: string;
  slug: string;
  name: string;
  cfg: string | null;
  extra_game_params: string | null;
  players_per_team: number | null;
};

type ModePluginRow = {
  plugin_slug: string;
  config: Record<string, unknown> | null;
  config_path: string | null;
  required: boolean;
  version: string | null;
};

export class RequiredPluginMissing extends Error {
  constructor(mode: string, plugins: Array<string>, where: string) {
    super(
      `"${mode}" requires ${plugins.join(", ")}, which ${
        plugins.length === 1 ? "is" : "are"
      } not installed on ${where}`,
    );
  }
}

@Injectable()
export class GameModesService {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly pluginRuntime: PluginRuntimeService,
  ) {}

  // A match's own mode always wins. A Ranked server never falls back to a
  // persistent one: matchmaking capacity has to come up clean every time, and a
  // fun match is expected to ask for its mode on the match itself.
  public async resolveForServer(
    serverId: string,
    matchId?: string,
  ): Promise<ResolvedGameMode | null> {
    const [row] = await this.postgres.query<
      Array<{
        game_mode_id: string | null;
        game_server_node_id: string | null;
        pin_plugin_runtime: string | null;
        is_ranked: boolean;
        is_tournament: boolean;
        is_ranked_server: boolean;
      }>
    >(
      `SELECT COALESCE(
                (SELECT mo.game_mode_id
                   FROM matches m
                   INNER JOIN match_options mo ON mo.id = m.match_options_id
                  WHERE m.id = $2),
                CASE WHEN s.type IS DISTINCT FROM 'Ranked'
                     THEN s.game_mode_id
                END
              ) AS game_mode_id,
              s.game_server_node_id,
              n.pin_plugin_runtime,
              COALESCE(
                (SELECT m.counts_toward_ranking FROM matches m WHERE m.id = $2),
                false
              ) AS is_ranked,
              EXISTS (
                SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = $2
              ) AS is_tournament,
              s.type = 'Ranked' AS is_ranked_server
         FROM servers s
         LEFT JOIN game_server_nodes n ON n.id = s.game_server_node_id
        WHERE s.id = $1`,
      [serverId, matchId ?? null],
    );

    // Scoped to the node this server is about to run on. link_plugins gates a
    // plugin's files on the exact slug@version pair being on that node's disk,
    // so naming a version another node happens to have newer boots the mode
    // with none of its plugins and nothing to say so.
    const scope: PluginScope = {
      nodeId: row?.game_server_node_id ?? null,
      runtime: await this.pluginRuntime.resolvePluginRuntime({
        pin_plugin_runtime: row?.pin_plugin_runtime ?? null,
      }),
      // A dedicated server is built before it has a match, and its plugin set
      // is baked into the pod -- so "decide later, per match" is not available
      // there. A Ranked server only ever hosts matchmaking, which is answer
      // enough; anything else falls through to the union of the other two
      // (see the ELSE in autoLoadPlugins), never to ranked.
      match: matchId
        ? GameModesService.matchScope({
            isTournament: row?.is_tournament ?? false,
            isRanked: row?.is_ranked ?? false,
          })
        : row?.is_ranked_server
          ? "ranked"
          : undefined,
    };

    const mode = row?.game_mode_id
      ? await this.resolve(row.game_mode_id, scope)
      : null;

    if (mode?.missingRequired.length) {
      throw new RequiredPluginMissing(
        mode.name,
        mode.missingRequired,
        scope.nodeId ?? `any node for ${scope.runtime}`,
      );
    }

    return await this.withAutoLoad(mode, scope);
  }

  // What a server would boot with if it ran this mode right now. Auto-load
  // plugins belong in the answer even though they are not part of the mode:
  // leaving them out is the one thing a preview exists to prevent.
  public async previewForMode(
    gameModeId: string,
  ): Promise<ResolvedGameMode | null> {
    return await this.withAutoLoad(await this.resolve(gameModeId));
  }

  // Auto-load plugins are merged in here rather than at the call sites,
  // because they apply whether or not a mode is selected -- a server with no
  // mode at all still has to load them, which is the entire point of them.
  private async withAutoLoad(
    mode: ResolvedGameMode | null,
    scope?: PluginScope,
  ): Promise<ResolvedGameMode | null> {
    const always = await this.autoLoadPlugins(scope);

    if (always.length === 0) {
      return await this.withServerGuidelines(mode);
    }

    const fromMode = (mode?.enabledPlugins ?? "").split(",").filter(Boolean);
    const modeSlugs = new Set(fromMode.map((entry) => entry.split("@")[0]));

    const enabled = [
      ...fromMode,
      // The mode wins a duplicate: it may pin a different version, and it is
      // the more specific statement of what this match should run.
      ...always.filter((entry) => !modeSlugs.has(entry.split("@")[0])),
    ];

    if (mode) {
      return await this.withServerGuidelines({
        ...mode,
        enabledPlugins: enabled.join(","),
      });
    }

    // No mode, but plugins that load regardless. Everything else is empty so
    // the server gets the plugins and none of a mode's cfg or launch params.
    return await this.withServerGuidelines({
      id: "",
      slug: "",
      name: "",
      cfg: null,
      extraGameParams: null,
      // No mode means no size override; the match keeps its type's count.
      playersPerTeam: null,
      enabledPlugins: enabled.join(","),
      pluginConfigs: null,
      missingRequired: [],
      disableServerGuidelines: false,
    });
  }

  // Both frameworks refuse the calls a HUD or scoreboard plugin needs while
  // FollowCS2ServerGuidelines is true, and Valve's position is that turning it
  // off can ban every GSLT on the account. So it takes both halves: the catalog
  // saying the plugin cannot work without it, and the operator having said yes
  // for that plugin. Decided from the plugins that are actually going to load,
  // so a mode that does not select the plugin leaves the server compliant.
  //
  // 5stack Ranks stands in for the operator's half, because it already turns
  // the same setting off to render ranks in-game. The ban it risks is against
  // the Steam account, not the server, so once ranks is on that risk is taken
  // deployment-wide and asking a second time per plugin would be asking about
  // nothing. It does not stand in for the catalog's half: a plugin that works
  // fine under the guidelines still leaves them on.
  private async withServerGuidelines(
    mode: ResolvedGameMode | null,
  ): Promise<ResolvedGameMode | null> {
    if (!mode?.enabledPlugins) {
      return mode;
    }

    const slugs = mode.enabledPlugins
      .split(",")
      .filter(Boolean)
      .map((entry) => entry.split("@")[0]);

    const [row] = await this.postgres.query<Array<{ disable: boolean }>>(
      `SELECT EXISTS (
                SELECT 1
                  FROM game_plugin_installs i
                  INNER JOIN game_plugins p ON p.slug = i.plugin_slug
                 WHERE i.plugin_slug = ANY($1::text[])
                   AND p.requires_server_guidelines_disabled = true
                   AND (
                     i.disable_server_guidelines = true
                     OR EXISTS (
                       SELECT 1 FROM settings
                        WHERE name IN ('fivestack_ranks_matches',
                                       'fivestack_ranks_tournaments')
                          AND value = 'true'
                     )
                   )
              ) AS disable`,
      [slugs],
    );

    return { ...mode, disableServerGuidelines: row?.disable ?? false };
  }

  public async resolve(
    gameModeId: string,
    scope?: PluginScope,
  ): Promise<ResolvedGameMode | null> {
    const [mode] = await this.postgres.query<Array<ModeRow>>(
      `SELECT id, slug, name, cfg, extra_game_params, players_per_team
         FROM game_modes
        WHERE id = $1 AND enabled = true AND archived_at IS NULL`,
      [gameModeId],
    );

    if (!mode) {
      return null;
    }

    const runtime =
      scope?.runtime ?? (await this.pluginRuntime.getPluginRuntime());
    const nodeId = scope?.nodeId ?? null;

    // The version a node actually has installed is what gets linked. Selecting
    // by the registry's newest instead would name a version that is not on disk,
    // and the server would boot silently without the plugin.
    const plugins = await this.postgres.query<Array<ModePluginRow>>(
      `SELECT mp.plugin_slug,
              mp.config,
              mp.required,
              p.config_path,
              (SELECT n.version
                 FROM game_server_node_plugins n
                WHERE n.plugin_slug = mp.plugin_slug
                  AND n.runtime = $2
                  AND n.status = 'Installed'
                  AND n.version IS NOT NULL
                  AND ($3::text IS NULL OR n.game_server_node_id = $3)
                ORDER BY n.updated_at DESC
                LIMIT 1) AS version
         FROM game_mode_plugins mp
         INNER JOIN game_plugins p ON p.slug = mp.plugin_slug
        WHERE mp.game_mode_id = $1
        ORDER BY mp.load_order ASC, mp.plugin_slug ASC`,
      [gameModeId, runtime, nodeId],
    );

    const enabled: Array<string> = [];
    const configs: Record<string, string> = {};
    const missingRequired: Array<string> = [];

    for (const plugin of plugins) {
      if (!plugin.version) {
        if (plugin.required) {
          missingRequired.push(plugin.plugin_slug);
        } else {
          this.logger.warn(
            `mode ${mode.slug}: ${plugin.plugin_slug} is not installed on ${
              nodeId ?? `any node for ${runtime}`
            }`,
          );
        }

        continue;
      }

      enabled.push(`${plugin.plugin_slug}@${plugin.version}`);

      if (plugin.config && plugin.config_path) {
        const path = plugin.config_path.replace("{runtime}", runtime);
        configs[path] = JSON.stringify(plugin.config, null, 2);
      }
    }

    return {
      id: mode.id,
      slug: mode.slug,
      name: mode.name,
      cfg: mode.cfg,
      extraGameParams: mode.extra_game_params,
      playersPerTeam: mode.players_per_team ?? null,
      enabledPlugins: enabled.join(","),
      pluginConfigs:
        Object.keys(configs).length > 0
          ? Buffer.from(JSON.stringify(configs)).toString("base64")
          : null,
      missingRequired,
      // Set once the whole plugin list is known; a mode's own plugins are only
      // half of what a server loads.
      disableServerGuidelines: false,
    };
  }

  // The buckets do not overlap, so a match that is both a tournament game and
  // a ranked one has to land in exactly one. Tournament wins: it is the more
  // specific statement about the match, and it has a switch of its own.
  public static matchScope(match: {
    isTournament: boolean;
    isRanked: boolean;
  }): MatchScope {
    if (match.isTournament) {
      return "tournaments";
    }

    if (match.isRanked) {
      return "ranked";
    }

    return "custom";
  }

  // The cvars each loading plugin carries, in the order the plugins load.
  //
  // Keyed off what the mode actually resolved to rather than off the install
  // table, so a plugin's cvars reach exactly the servers running it: out of
  // scope it never made the list, and a mode that names it explicitly gets its
  // cvars even where the blanket flag was turned off, because the plugin is
  // running there either way and half-configured is worse than not loaded.
  public async pluginCfgLayers(
    mode: ResolvedGameMode | null,
  ): Promise<Array<{ slug: string; cfg: string }>> {
    const slugs = (mode?.enabledPlugins ?? "")
      .split(",")
      .filter(Boolean)
      .map((entry) => entry.split("@")[0]);

    if (slugs.length === 0) {
      return [];
    }

    const rows = await this.postgres.query<
      Array<{ plugin_slug: string; cfg: string }>
    >(
      `SELECT plugin_slug, cfg
         FROM game_plugin_installs
        WHERE plugin_slug = ANY($1::text[])
          AND enabled = true
          AND cfg IS NOT NULL
          AND btrim(cfg) <> ''`,
      [slugs],
    );

    const cfgs = new Map(rows.map((row) => [row.plugin_slug, row.cfg]));

    return slugs
      .filter((slug) => cfgs.has(slug))
      .map((slug) => ({ slug, cfg: cfgs.get(slug) as string }));
  }

  // Plugins that load without a game mode asking for them: a stats collector
  // is not a game mode, and hand-placing it in custom-plugins is what this
  // replaces. Each install says which of the three kinds of match it wants,
  // so a plugin can sit on customs and tournaments and stay off ranked.
  //
  // With no match in scope the caller is building a server, not a match. Ranked
  // is excluded from that union deliberately: a plugin the operator kept off
  // ranked must not be baked into a pod that might later host a ranked match.
  public async autoLoadPlugins(scope?: PluginScope): Promise<Array<string>> {
    const runtime =
      scope?.runtime ?? (await this.pluginRuntime.getPluginRuntime());
    const nodeId = scope?.nodeId ?? null;

    const rows = await this.postgres.query<
      Array<{ plugin_slug: string; version: string | null }>
    >(
      `SELECT i.plugin_slug,
              (SELECT n.version
                 FROM game_server_node_plugins n
                WHERE n.plugin_slug = i.plugin_slug
                  AND n.runtime = $1
                  AND n.status = 'Installed'
                  AND n.version IS NOT NULL
                  AND ($2::text IS NULL OR n.game_server_node_id = $2)
                ORDER BY n.updated_at DESC
                LIMIT 1) AS version
         FROM game_plugin_installs i
        WHERE i.enabled = true
          AND CASE $3::text
                WHEN 'ranked' THEN i.load_ranked
                WHEN 'tournaments' THEN i.load_tournaments
                WHEN 'custom' THEN i.load_custom
                ELSE i.load_tournaments OR i.load_custom
              END
        ORDER BY i.plugin_slug`,
      [runtime, nodeId, scope?.match ?? null],
    );

    return rows
      .filter((row) => row.version)
      .map((row) => `${row.plugin_slug}@${row.version}`);
  }

  // The env a game server pod needs. Every pod builder resolves the mode itself
  // -- it needs extraGameParams as well -- so this maps rather than resolves,
  // and there is one place that knows what the container reads.
  public environmentFor(
    mode: ResolvedGameMode | null,
  ): Array<{ name: string; value: string }> {
    if (!mode?.enabledPlugins) {
      return [];
    }

    const environment = [
      { name: "ENABLED_PLUGINS", value: mode.enabledPlugins },
    ];

    if (mode.pluginConfigs) {
      environment.push({ name: "PLUGIN_CONFIGS", value: mode.pluginConfigs });
    }

    // setup.sh patches FollowCS2ServerGuidelines in the framework's own config
    // before the server starts; there is no way to change it from inside a
    // running server.
    if (mode.disableServerGuidelines) {
      environment.push({ name: "DISABLE_SERVER_GUIDELINES", value: "true" });
    }

    return environment;
  }
}
