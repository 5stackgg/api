import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { CacheService } from "../cache/cache.service";

export type ListedCvar = {
  name: string;
  kind: string;
  flags: string;
  description: string;
};

export type CvarKind = "bool" | "int" | "float" | "string";

type PendingPlugin = {
  slug: string;
  version: string;
  runtime: string;
  cvars: Array<string>;
};

@Injectable()
export class PluginCvarsService {
  // A plugin installed on a node is not necessarily loaded on every server
  // there, so a server that does not run it is asked again only this often --
  // or as soon as it restarts, which is when its plugin set can change.
  private static readonly RETRY_AFTER_SECONDS = 6 * 60 * 60;

  // Each release is read once per runtime. Nodes on different versions would
  // otherwise overwrite each other's rows and both re-read every minute.
  private static readonly REPORTED_SECONDS = 30 * 24 * 60 * 60;

  private static readonly NAME = /^[A-Za-z0-9_.]+$/;

  // Never shown as a plugin's default, whatever a server says it holds.
  private static readonly SECRET = /api_?key|password|passwd|secret|token/i;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly cache: CacheService,
  ) {}

  // The catalog only names a plugin's cvars. What each one is for and what it
  // defaults to is only knowable from a server that has the plugin loaded.
  public async harvest(
    serverId: string,
    list: (name: string) => Promise<Array<ListedCvar>>,
    options: { restarted?: boolean } = {},
  ): Promise<void> {
    for (const plugin of await this.pending(serverId)) {
      const reported = PluginCvarsService.reportedKey(plugin);

      if (await this.cache.has(reported)) {
        continue;
      }

      const attempt = `plugin-cvars:${serverId}:${plugin.slug}:${plugin.version}`;

      if (!options.restarted && (await this.cache.has(attempt))) {
        continue;
      }

      const found: Array<ListedCvar> = [];

      for (const name of plugin.cvars) {
        const match = (await list(name)).find(
          (entry) => entry.name.toLowerCase() === name.toLowerCase(),
        );

        if (match && match.kind !== "cmd") {
          found.push({ ...match, name });
        }
      }

      if (found.length === 0) {
        await this.cache.put(
          attempt,
          true,
          PluginCvarsService.RETRY_AFTER_SECONDS,
        );
        continue;
      }

      await this.record(plugin, found);
      await this.cache.put(reported, true, PluginCvarsService.REPORTED_SECONDS);

      this.logger.log(
        `read ${found.length} ${plugin.slug}@${plugin.version} cvars from ${serverId}`,
      );
    }
  }

  private async pending(serverId: string): Promise<Array<PendingPlugin>> {
    const rows = await this.postgres.query<Array<PendingPlugin>>(
      `SELECT n.plugin_slug AS slug, n.version, n.runtime, p.cvars
         FROM public.servers s
         INNER JOIN public.game_server_node_plugins n
                 ON n.game_server_node_id = s.game_server_node_id
         INNER JOIN public.game_plugins p ON p.slug = n.plugin_slug
        WHERE s.id = $1
          AND n.status = 'Installed'
          AND n.detected = true
          AND n.version IS NOT NULL
          AND cardinality(p.cvars) > 0`,
      [serverId],
    );

    return rows.map((row) => ({
      ...row,
      cvars: row.cvars.filter((name) => PluginCvarsService.NAME.test(name)),
    }));
  }

  // The catalog's list is part of the key, so a cvar it adds later is read
  // without waiting for the plugin's next release.
  private static reportedKey(plugin: PendingPlugin): string {
    const listed = createHash("sha1")
      .update([...plugin.cvars].sort().join(","))
      .digest("hex")
      .slice(0, 12);

    return `plugin-cvars:reported:${plugin.slug}:${plugin.runtime}:${plugin.version}:${listed}`;
  }

  // A value counts as the default only where nothing the panel delivers set
  // it, so a server running an operator's config never records their value as
  // what the plugin ships with. An earlier default is kept rather than lost.
  private async record(
    plugin: PendingPlugin,
    found: Array<ListedCvar>,
  ): Promise<void> {
    const setByPanel = await this.cvarsSetByPanel();

    for (const cvar of found) {
      const unknown =
        setByPanel.has(cvar.name.toLowerCase()) ||
        PluginCvarsService.SECRET.test(cvar.name);

      await this.postgres.query(
        `INSERT INTO public.game_plugin_cvars
           (plugin_slug, name, runtime, version, kind, default_value,
            description, flags, reported_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (plugin_slug, name) DO UPDATE SET
           runtime = EXCLUDED.runtime,
           version = EXCLUDED.version,
           kind = EXCLUDED.kind,
           default_value = COALESCE(
             EXCLUDED.default_value, game_plugin_cvars.default_value),
           description = EXCLUDED.description,
           flags = EXCLUDED.flags,
           reported_at = now()`,
        [
          plugin.slug,
          cvar.name,
          plugin.runtime,
          plugin.version,
          PluginCvarsService.kindOf(cvar.kind),
          unknown ? null : cvar.kind,
          cvar.description,
          cvar.flags,
        ],
      );
    }

    // By the catalog's list rather than by what this server had: two releases
    // can differ, and whichever reported last would delete the other's.
    await this.postgres.query(
      `DELETE FROM public.game_plugin_cvars
        WHERE plugin_slug = $1 AND name <> ALL($2::text[])`,
      [plugin.slug, plugin.cvars],
    );
  }

  private async cvarsSetByPanel(): Promise<Set<string>> {
    const rows = await this.postgres.query<Array<{ cfg: string }>>(
      `SELECT cfg FROM public.game_plugin_installs WHERE cfg IS NOT NULL
       UNION ALL
       SELECT cfg FROM public.game_modes WHERE cfg IS NOT NULL
       UNION ALL
       SELECT cfg FROM public.match_type_cfgs
       UNION ALL
       SELECT p.config_cvar
         FROM public.game_plugins p
        WHERE p.config_cvar IS NOT NULL
          AND (EXISTS (SELECT 1 FROM public.game_plugin_installs i
                        WHERE i.plugin_slug = p.slug AND i.config IS NOT NULL)
               OR EXISTS (SELECT 1 FROM public.game_mode_plugins m
                           WHERE m.plugin_slug = p.slug AND m.config IS NOT NULL))`,
    );

    const launch = await this.postgres.query<Array<{ params: string }>>(
      `SELECT extra_game_params AS params
         FROM public.game_modes
        WHERE extra_game_params IS NOT NULL`,
    );

    return new Set([
      ...rows.flatMap((row) => PluginCvarsService.cvarNames(row.cfg)),
      ...launch.flatMap((row) =>
        PluginCvarsService.launchCvarNames(row.params),
      ),
    ]);
  }

  // Commands can share a line with ";" and a name can be quoted; both still
  // set the cvar when the server execs the file.
  public static cvarNames(cfg: string): Array<string> {
    return cfg
      .split(/[\n;]/)
      .map((command) =>
        command
          .replace(/\/\/.*$/, "")
          .trim()
          .split(/\s+/)[0]
          .replace(/^"(.*)"$/, "$1"),
      )
      .filter((name) => name && PluginCvarsService.NAME.test(name))
      .map((name) => name.toLowerCase());
  }

  public static launchCvarNames(params: string): Array<string> {
    return params
      .split(/\s+/)
      .filter((token) => token.startsWith("+"))
      .map((token) => token.slice(1))
      .filter((name) => PluginCvarsService.NAME.test(name))
      .map((name) => name.toLowerCase());
  }

  public static kindOf(value: string): CvarKind {
    if (value === "true" || value === "false") {
      return "bool";
    }

    if (/^-?\d+$/.test(value)) {
      return "int";
    }

    if (/^-?(\d+\.\d*|\.\d+)(e[-+]?\d+)?$/i.test(value)) {
      return "float";
    }

    return "string";
  }
}
