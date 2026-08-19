import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { PluginRuntimeService } from "../plugin-runtime/plugin-runtime.service";

export type ResolvedGameMode = {
  id: string;
  slug: string;
  name: string;
  cfg: string | null;
  extraGameParams: string | null;
  enabledPlugins: string;
  pluginConfigs: string | null;
};

type ModeRow = {
  id: string;
  slug: string;
  name: string;
  cfg: string | null;
  extra_game_params: string | null;
};

type ModePluginRow = {
  plugin_slug: string;
  config: Record<string, unknown> | null;
  config_path: string | null;
  required: boolean;
  version: string | null;
};

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
    const [row] = await this.postgres.query<Array<{ game_mode_id: string | null }>>(
      `SELECT COALESCE(
                (SELECT mo.game_mode_id
                   FROM matches m
                   INNER JOIN match_options mo ON mo.id = m.match_options_id
                  WHERE m.id = $2),
                (SELECT s.game_mode_id FROM servers s
                  WHERE s.id = $1 AND s.type IS DISTINCT FROM 'Ranked')
              ) AS game_mode_id`,
      [serverId, matchId ?? null],
    );

    const mode = row?.game_mode_id
      ? await this.resolve(row.game_mode_id)
      : null;

    return await this.withAlwaysLoad(mode);
  }

  // Always-load plugins are merged in here rather than at the call sites,
  // because they apply whether or not a mode is selected -- a server with no
  // mode at all still has to load them, which is the entire point of the flag.
  private async withAlwaysLoad(
    mode: ResolvedGameMode | null,
  ): Promise<ResolvedGameMode | null> {
    const always = await this.alwaysLoadPlugins();

    if (always.length === 0) {
      return mode;
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
      return { ...mode, enabledPlugins: enabled.join(",") };
    }

    // No mode, but plugins that load regardless. Everything else is empty so
    // the server gets the plugins and none of a mode's cfg or launch params.
    return {
      id: "",
      slug: "",
      name: "",
      cfg: null,
      extraGameParams: null,
      enabledPlugins: enabled.join(","),
      pluginConfigs: null,
    };
  }

  public async resolve(gameModeId: string): Promise<ResolvedGameMode | null> {
    const [mode] = await this.postgres.query<Array<ModeRow>>(
      `SELECT id, slug, name, cfg, extra_game_params
         FROM game_modes
        WHERE id = $1 AND enabled = true AND archived_at IS NULL`,
      [gameModeId],
    );

    if (!mode) {
      return null;
    }

    const runtime = await this.pluginRuntime.getPluginRuntime();

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
                ORDER BY n.updated_at DESC
                LIMIT 1) AS version
         FROM game_mode_plugins mp
         INNER JOIN game_plugins p ON p.slug = mp.plugin_slug
        WHERE mp.game_mode_id = $1
        ORDER BY mp.load_order ASC, mp.plugin_slug ASC`,
      [gameModeId, runtime],
    );

    const enabled: Array<string> = [];
    const configs: Record<string, string> = {};

    for (const plugin of plugins) {
      if (!plugin.version) {
        this.logger.warn(
          `mode ${mode.slug}: ${plugin.plugin_slug} is not installed on any node for ${runtime}`,
        );
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
      enabledPlugins: enabled.join(","),
      pluginConfigs:
        Object.keys(configs).length > 0
          ? Buffer.from(JSON.stringify(configs)).toString("base64")
          : null,
    };
  }

  // Plugins marked always_load are loaded by every server regardless of mode,
  // ranked included. That is the point of the flag: a stats collector is not a
  // game mode, and hand-placing it in custom-plugins is what this replaces.
  public async alwaysLoadPlugins(): Promise<Array<string>> {
    const runtime = await this.pluginRuntime.getPluginRuntime();

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
                ORDER BY n.updated_at DESC
                LIMIT 1) AS version
         FROM game_plugin_installs i
        WHERE i.enabled = true AND i.always_load = true
        ORDER BY i.plugin_slug`,
      [runtime],
    );

    return rows
      .filter((row) => row.version)
      .map((row) => `${row.plugin_slug}@${row.version}`);
  }

  // The env a game server pod needs, for callers that want it prepared rather
  // than assembling it themselves.
  public async environmentFor(
    serverId: string,
    matchId?: string,
  ): Promise<Array<{ name: string; value: string }>> {
    const mode = await this.resolveForServer(serverId, matchId);

    if (!mode?.enabledPlugins) {
      return [];
    }

    const environment = [
      { name: "ENABLED_PLUGINS", value: mode.enabledPlugins },
    ];

    if (mode.pluginConfigs) {
      environment.push({ name: "PLUGIN_CONFIGS", value: mode.pluginConfigs });
    }

    return environment;
  }
}
