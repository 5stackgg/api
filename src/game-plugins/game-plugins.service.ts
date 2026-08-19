import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { PluginRuntimeService } from "../plugin-runtime/plugin-runtime.service";
import { CacheService } from "../cache/cache.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import {
  NodeInventoryPlugin,
  RegistryIndex,
  RegistryPlugin,
} from "./types/Registry";

@Injectable()
export class GamePluginsService {
  private static readonly DEFAULT_REGISTRY_URL =
    "https://registry.5stack.gg/";

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly pluginRuntime: PluginRuntimeService,
    private readonly cache: CacheService,
  ) {}

  public async getRegistryUrl(): Promise<string> {
    const [setting] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.GamePluginRegistryUrl],
    );

    return setting?.value?.trim() || GamePluginsService.DEFAULT_REGISTRY_URL;
  }

  public async syncRegistry(): Promise<{ plugins: number; versions: number }> {
    const url = await this.getRegistryUrl();

    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new BadRequestException(
        `registry responded ${response.status} for ${url}`,
      );
    }

    const index = (await response.json()) as RegistryIndex;

    // A registry that came back empty is far more likely to be a broken
    // publish than a real emptying of the catalog. Refusing to apply it keeps
    // installed plugins resolvable instead of orphaning every mode at once.
    if (!Array.isArray(index?.plugins) || index.plugins.length === 0) {
      this.logger.warn(`registry at ${url} returned no plugins; keeping cache`);
      return { plugins: 0, versions: 0 };
    }

    let versions = 0;

    for (const plugin of index.plugins) {
      versions += await this.upsertPlugin(plugin);
    }

    // A plugin pulled from the registry is only forgotten if nothing depends on
    // it. game_mode_plugins is RESTRICT, so deleting one a mode still selects
    // would abort the whole sync and leave the catalog half-applied.
    await this.postgres.query(
      `DELETE FROM public.game_plugins p
        WHERE p.slug <> ALL($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM public.game_mode_plugins m WHERE m.plugin_slug = p.slug
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.game_server_node_plugins n WHERE n.plugin_slug = p.slug
          )`,
      [index.plugins.map((plugin) => plugin.slug)],
    );

    this.logger.log(
      `registry sync: ${index.plugins.length} plugins, ${versions} versions`,
    );

    return { plugins: index.plugins.length, versions };
  }

  private async upsertPlugin(plugin: RegistryPlugin): Promise<number> {
    await this.postgres.query(
      `INSERT INTO public.game_plugins
         (slug, kind, name, author, description, homepage, tags, verified,
          hot_swappable, requires_service, config_schema, config_path, cvars,
          panel, wiring, pairs_with, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (slug) DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         author = EXCLUDED.author,
         description = EXCLUDED.description,
         homepage = EXCLUDED.homepage,
         tags = EXCLUDED.tags,
         verified = EXCLUDED.verified,
         hot_swappable = EXCLUDED.hot_swappable,
         requires_service = EXCLUDED.requires_service,
         config_schema = EXCLUDED.config_schema,
         config_path = EXCLUDED.config_path,
         cvars = EXCLUDED.cvars,
         panel = EXCLUDED.panel,
         wiring = EXCLUDED.wiring,
         pairs_with = EXCLUDED.pairs_with,
         synced_at = now()`,
      [
        plugin.slug,
        plugin.kind,
        plugin.name,
        plugin.author,
        plugin.description,
        plugin.homepage ?? null,
        plugin.tags ?? [],
        plugin.verified ?? false,
        plugin.hot_swappable ?? false,
        plugin.requires_service ?? null,
        plugin.config_schema ? JSON.stringify(plugin.config_schema) : null,
        plugin.config_path ?? null,
        plugin.cvars ?? [],
        plugin.panel ? JSON.stringify(plugin.panel) : null,
        plugin.wiring ? JSON.stringify(plugin.wiring) : null,
        plugin.pairs_with ?? [],
      ],
    );

    const versions = plugin.versions ?? [];

    for (const version of versions) {
      await this.postgres.query(
        `INSERT INTO public.game_plugin_versions
           (plugin_slug, runtime, version, url, sha256, size, published_at,
            prerelease, layout, install_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (plugin_slug, runtime, version) DO UPDATE SET
           url = EXCLUDED.url,
           sha256 = EXCLUDED.sha256,
           size = EXCLUDED.size,
           published_at = EXCLUDED.published_at,
           prerelease = EXCLUDED.prerelease,
           layout = EXCLUDED.layout,
           install_path = EXCLUDED.install_path`,
        [
          plugin.slug,
          version.runtime,
          version.version,
          version.url,
          version.sha256,
          version.size ?? null,
          version.published_at,
          version.prerelease ?? false,
          version.layout ?? "csgo",
          version.install_path ?? null,
        ],
      );
    }

    // Versions the upstream repo no longer publishes are dropped unless a node
    // still has them installed, so a pinned node never loses its download URL.
    await this.postgres.query(
      `DELETE FROM public.game_plugin_versions v
        WHERE v.plugin_slug = $1
          AND v.version <> ALL($2::text[])
          AND NOT EXISTS (
            SELECT 1 FROM public.game_server_node_plugins n
             WHERE n.plugin_slug = v.plugin_slug AND n.version = v.version
          )`,
      [plugin.slug, versions.map((version) => version.version)],
    );

    return versions.length;
  }

  // Everything a node should have on disk, already resolved to concrete
  // downloads. The connector converges to this list and never reads the
  // catalog itself, so "which version is newest for this runtime" is decided in
  // exactly one place.
  public async desiredForNode(nodeId: string): Promise<{
    runtime: string;
    plugins: Array<{
      slug: string;
      version: string;
      url: string;
      sha256: string;
      layout: string;
      installPath: string | null;
    }>;
  }> {
    const [node] = await this.postgres.query<
      Array<{ pin_plugin_runtime: string | null }>
    >(`SELECT pin_plugin_runtime FROM public.game_server_nodes WHERE id = $1`, [
      nodeId,
    ]);

    if (!node) {
      throw new NotFoundException(`Node ${nodeId} is not registered`);
    }

    const runtime = await this.pluginRuntime.resolvePluginRuntime({
      pin_plugin_runtime: node.pin_plugin_runtime,
    });

    const desired = await this.postgres.query<
      Array<{ plugin_slug: string; version: string | null }>
    >(
      `SELECT plugin_slug, version FROM public.game_plugin_installs
        WHERE enabled = true
        ORDER BY plugin_slug`,
    );

    const plugins = [];

    for (const row of desired) {
      try {
        const resolved = await this.resolveVersion(
          row.plugin_slug,
          runtime,
          row.version ?? undefined,
        );

        plugins.push({
          slug: row.plugin_slug,
          version: resolved.version,
          url: resolved.url,
          sha256: resolved.sha256,
          layout: resolved.layout,
          installPath: resolved.install_path,
        });
      } catch (error) {
        // A plugin with no build for this runtime is not an error the node can
        // act on, and failing the whole manifest would stall every other one.
        this.logger.warn(
          `${row.plugin_slug} has no ${runtime} release to send to ${nodeId}`,
        );
      }
    }

    return { runtime, plugins };
  }

  // What a node reports it converged to. Replaces the row set wholesale so a
  // plugin removed on disk stops being listed as installed.
  public async recordNodeState(
    nodeId: string,
    reported: Array<{
      slug: string;
      version: string | null;
      runtime: string | null;
      source: "managed" | "manual";
    }>,
  ): Promise<void> {
    const runtime = await this.pluginRuntime.getPluginRuntime();

    for (const plugin of reported) {
      await this.postgres.query(
        `INSERT INTO public.game_server_node_plugins
           (game_server_node_id, plugin_slug, runtime, version, detected_version,
            source, detected, status, updated_at)
         VALUES ($1, $2, $3, $4, $4, $5, true, 'Installed', now())
         ON CONFLICT (game_server_node_id, plugin_slug) DO UPDATE SET
           version = EXCLUDED.version,
           detected_version = EXCLUDED.detected_version,
           detected = true,
           status = 'Installed',
           source = EXCLUDED.source,
           runtime = COALESCE(EXCLUDED.runtime, game_server_node_plugins.runtime),
           last_error = null,
           updated_at = now()`,
        [
          nodeId,
          plugin.slug,
          plugin.runtime ?? runtime,
          plugin.version,
          plugin.source,
        ],
      );
    }

    const slugs = reported.map((plugin) => plugin.slug);

    // A requested plugin that is not on disk yet is Pending, not gone. Deleting
    // the row would drop the record that it was ever asked for, and the panel
    // would be back to inferring a state from an absent row. A Failed row keeps
    // its status so the error stays readable.
    await this.postgres.query(
      `UPDATE public.game_server_node_plugins n
          SET detected = false,
              status = CASE WHEN n.status = 'Failed' THEN 'Failed' ELSE 'Pending' END,
              updated_at = now()
        WHERE n.game_server_node_id = $1
          AND n.plugin_slug <> ALL($2::text[])
          AND EXISTS (
                SELECT 1 FROM public.game_plugin_installs i
                 WHERE i.plugin_slug = n.plugin_slug AND i.enabled = true)`,
      [nodeId, slugs],
    );

    await this.postgres.query(
      `DELETE FROM public.game_server_node_plugins n
        WHERE n.game_server_node_id = $1
          AND n.plugin_slug <> ALL($2::text[])
          AND NOT EXISTS (
                SELECT 1 FROM public.game_plugin_installs i
                 WHERE i.plugin_slug = n.plugin_slug AND i.enabled = true)`,
      [nodeId, slugs],
    );

    await this.postgres.query(
      `UPDATE public.game_server_nodes SET plugins_synced_at = now() WHERE id = $1`,
      [nodeId],
    );
  }

  // A plugin's README is the only real description of what it does. It is
  // fetched here rather than from the browser so the token (when set) stays
  // server-side and one cache entry serves every admin looking at the page.
  public async readme(
    slug: string,
    runtime?: string | null,
  ): Promise<{
    content: string;
    format: "markdown" | "text";
    repo: string;
    url: string;
  } | null> {
    const cacheKey = `game-plugin:readme:${slug}:${runtime ?? "default"}`;
    const cached = await this.cache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const repo = await this.resolveRepo(slug, runtime);

    if (!repo) {
      return null;
    }

    // The JSON form rather than the raw file, because the file NAME decides how
    // to render it. Plenty of projects ship a plain Readme.txt, and running that
    // through a markdown parser silently mangles it -- indented lines become
    // code blocks or get folded into the paragraph above.
    const response = await fetch(
      `https://api.github.com/repos/${repo}/readme`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "5stack-panel",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      this.logger.warn(`no README for ${repo}: ${response.status}`);
      await this.cache.put(cacheKey, null, 60 * 30);
      return null;
    }

    const body = (await response.json()) as {
      name?: string;
      content?: string;
      encoding?: string;
    };

    if (!body.content) {
      await this.cache.put(cacheKey, null, 60 * 30);
      return null;
    }

    const decoded = Buffer.from(body.content, "base64").toString("utf8");
    const isMarkdown = /\.(md|markdown|mdown|mkd)$/i.test(body.name ?? "");

    const readme = {
      content: isMarkdown
        ? this.absolutizeMarkdown(decoded, repo)
        : decoded,
      format: (isMarkdown ? "markdown" : "text") as "markdown" | "text",
      repo,
      url: `https://github.com/${repo}`,
    };

    await this.cache.put(cacheKey, readme, 60 * 60 * 6);

    return readme;
  }

  private async resolveRepo(
    slug: string,
    runtime?: string | null,
  ): Promise<string | null> {
    const [plugin] = await this.postgres.query<
      Array<{ homepage: string | null; panel: { repo?: string } | null }>
    >(`SELECT homepage, panel FROM public.game_plugins WHERE slug = $1`, [slug]);

    if (!plugin) {
      throw new NotFoundException(`${slug} is not in the catalog`);
    }

    // A plugin built for both frameworks is two separate repositories with two
    // separate READMEs, and homepage only ever names one of them. The release
    // URL is per-runtime and carries the owner and repo that published it, so
    // the variant's repo is derivable without storing it a second time.
    if (runtime) {
      const repo = await this.repoFromRelease(slug, runtime);

      if (repo) {
        return repo;
      }
    }

    const fromHomepage = plugin.homepage?.match(
      /^https?:\/\/github\.com\/([^/]+\/[^/#?]+)/i,
    );

    if (fromHomepage) {
      return fromHomepage[1].replace(/\.git$/, "");
    }

    if (plugin.panel?.repo) {
      return plugin.panel.repo;
    }

    return await this.repoFromRelease(slug);
  }

  private async repoFromRelease(
    slug: string,
    runtime?: string,
  ): Promise<string | null> {
    const [version] = await this.postgres.query<Array<{ url: string }>>(
      runtime
        ? `SELECT url FROM public.game_plugin_versions
             WHERE plugin_slug = $1 AND runtime = $2
             ORDER BY published_at DESC LIMIT 1`
        : `SELECT url FROM public.game_plugin_versions
             WHERE plugin_slug = $1
             ORDER BY published_at DESC LIMIT 1`,
      runtime ? [slug, runtime] : [slug],
    );

    const fromRelease = version?.url?.match(
      /^https?:\/\/github\.com\/([^/]+\/[^/]+)\//i,
    );

    return fromRelease ? fromRelease[1] : null;
  }

  // READMEs reference their own repo with relative paths, which resolve against
  // the panel's origin and 404 once the markdown is rendered anywhere else.
  private absolutizeMarkdown(markdown: string, repo: string): string {
    const raw = `https://raw.githubusercontent.com/${repo}/HEAD/`;
    const blob = `https://github.com/${repo}/blob/HEAD/`;

    return markdown.replace(
      /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
      (match, bang, text, target, title) => {
        if (/^([a-z]+:|\/\/|#)/i.test(target)) {
          return match;
        }

        const base = bang ? raw : blob;
        const absolute = `${base}${target.replace(/^\.?\//, "")}`;

        return `${bang}[${text}](${absolute}${title ?? ""})`;
      },
    );
  }

  // Records what a server reported loading. The RCON call itself lives with the
  // caller: RconService already reaches MatchesModule, and importing it here
  // closed a module cycle that stopped the whole API booting.
  //
  // null means "could not be asked" -- SwiftlyS2 routes `sw plugins list` to
  // its own log sink and returns an empty RCON body, and recording that as an
  // empty list would report every plugin on the server as failed to load.
  public async recordLoadedPlugins(
    serverId: string,
    loaded: Array<string> | null,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.servers
          SET loaded_plugins = $2::jsonb, plugins_checked_at = now()
        WHERE id = $1`,
      [serverId, loaded === null ? null : JSON.stringify(loaded)],
    );
  }

  // css_plugins list prints a numbered block per plugin:
  //   [1] "Name" (v1.2.3) by Author
  public static parseCssPluginList(output: string): Array<string> {
    const names: Array<string> = [];

    for (const line of output.split("\n")) {
      const match = line.match(/^\s*\[\s*\d+\s*\]\s*"?([^"(]+?)"?\s*(?:\(|$)/);

      if (match?.[1]) {
        names.push(match[1].trim());
      }
    }

    return names;
  }

  public async resolveVersion(
    slug: string,
    runtime: string,
    version?: string,
  ): Promise<{
    version: string;
    url: string;
    sha256: string;
    layout: string;
    install_path: string | null;
  }> {
    const [row] = await this.postgres.query<
      Array<{
        version: string;
        url: string;
        sha256: string;
        layout: string;
        install_path: string | null;
      }>
    >(
      `SELECT version, url, sha256, layout, install_path
         FROM public.game_plugin_versions
        WHERE plugin_slug = $1
          AND runtime = $2
          AND ($3::text IS NULL OR version = $3)
        ORDER BY published_at DESC
        LIMIT 1`,
      [slug, runtime, version ?? null],
    );

    if (!row) {
      throw new NotFoundException(
        version
          ? `${slug} ${version} is not published for ${runtime}`
          : `${slug} has no ${runtime} release`,
      );
    }

    return row;
  }

  public async install(
    nodeId: string,
    slug: string,
    version?: string,
  ): Promise<void> {
    const runtime = await this.pluginRuntime.getPluginRuntime();
    const resolved = await this.resolveVersion(slug, runtime, version);

    await this.recordInstall(nodeId, slug, runtime, {
      version: resolved.version,
      status: "Installing",
      last_error: null,
    });

    try {
      await this.callNode(nodeId, "install", {
        method: "POST",
        body: JSON.stringify({
          slug,
          version: resolved.version,
          url: resolved.url,
          sha256: resolved.sha256,
          layout: resolved.layout,
          installPath: resolved.install_path ?? undefined,
        }),
      });

      await this.recordInstall(nodeId, slug, runtime, {
        version: resolved.version,
        status: "Installed",
        last_error: null,
        installed_at: new Date().toISOString(),
      });
    } catch (error) {
      await this.recordInstall(nodeId, slug, runtime, {
        version: resolved.version,
        status: "Failed",
        last_error: error.message ?? String(error),
      });

      throw error;
    }
  }

  // Named rather than counted: the confirmation is only useful if it says which
  // modes are about to lose the plugin.
  public async modesUsing(
    slug: string,
  ): Promise<Array<{ id: string; name: string }>> {
    return await this.postgres.query<Array<{ id: string; name: string }>>(
      `SELECT m.id, m.name
         FROM public.game_mode_plugins p
         INNER JOIN public.game_modes m ON m.id = p.game_mode_id
        WHERE p.plugin_slug = $1 AND m.archived_at IS NULL
        ORDER BY m.name`,
      [slug],
    );
  }

  // Installing records intent. Nodes converge to it on their own schedule, so a
  // node that is offline right now, or joins the cluster next week, ends up with
  // the same set without anyone re-running anything.
  //
  // channel follows the version: naming one pins it, omitting one tracks the
  // newest release. Both are reachable from the UI -- pinning by installing a
  // specific version, tracking by installing without one.
  public async requestInstall(slug: string, version?: string): Promise<void> {
    const [plugin] = await this.postgres.query<Array<{ slug: string }>>(
      `SELECT slug FROM public.game_plugins WHERE slug = $1`,
      [slug],
    );

    if (!plugin) {
      throw new NotFoundException(`${slug} is not in the catalog`);
    }

    await this.postgres.query(
      `INSERT INTO public.game_plugin_installs (plugin_slug, version, channel, enabled)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (plugin_slug) DO UPDATE SET
         version = EXCLUDED.version,
         channel = EXCLUDED.channel,
         enabled = true,
         updated_at = now()`,
      [slug, version ?? null, version ? "Pinned" : "Auto"],
    );

    await this.seedPending(slug);

    this.nudgeNodes();
  }

  public async requestUninstall(slug: string, force = false): Promise<void> {
    const inUse = await this.modesUsing(slug);

    // Being used by a mode is a reason to ask, not a reason to refuse. Making
    // the operator go and edit every mode first was busywork for something they
    // had already decided.
    if (inUse.length > 0 && !force) {
      throw new BadRequestException(
        `${slug} is used by ${inUse.map((mode) => `"${mode.name}"`).join(", ")}`,
      );
    }

    if (inUse.length > 0) {
      await this.postgres.query(
        `DELETE FROM public.game_mode_plugins WHERE plugin_slug = $1`,
        [slug],
      );
    }

    await this.postgres.query(
      `DELETE FROM public.game_plugin_installs WHERE plugin_slug = $1`,
      [slug],
    );

    this.nudgeNodes();
  }

  public async uninstall(nodeId: string, slug: string): Promise<void> {
    const [inUse] = await this.postgres.query<Array<{ name: string }>>(
      `SELECT m.name
         FROM public.game_mode_plugins p
         INNER JOIN public.game_modes m ON m.id = p.game_mode_id
        WHERE p.plugin_slug = $1 AND m.archived_at IS NULL
        LIMIT 1`,
      [slug],
    );

    if (inUse) {
      throw new BadRequestException(
        `${slug} is used by the "${inUse.name}" mode; remove it from the mode first`,
      );
    }

    await this.callNode(nodeId, "remove", {
      method: "DELETE",
      body: JSON.stringify({ slug }),
    });

    await this.postgres.query(
      `DELETE FROM public.game_server_node_plugins
        WHERE game_server_node_id = $1 AND plugin_slug = $2`,
      [nodeId, slug],
    );
  }

  // Asks a node to converge now and report back. The node owns its own state,
  // so the API nudges rather than reaching in and writing the same rows -- two
  // writers doing wholesale replaces on one table is a race, not a safety net.
  public async syncNode(nodeId: string): Promise<number> {
    const { plugins } = (await this.callNode(nodeId, "sync", {
      method: "POST",
      body: "{}",
    })) as { plugins: Array<{ slug: string }> };

    return plugins.length;
  }

  // A requested plugin has a real state on every node from the moment it is
  // requested: Pending. Leaving the row absent until the node reports meant the
  // panel could only guess, and it guessed "Installing" for a node that had not
  // even been told yet.
  private async seedPending(slug: string): Promise<void> {
    const runtime = await this.pluginRuntime.getPluginRuntime();

    await this.postgres.query(
      `INSERT INTO public.game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, status, source, detected)
       SELECT id, $1, $2, 'Pending', 'managed', false
         FROM public.game_server_nodes
        WHERE enabled = true
       ON CONFLICT (game_server_node_id, plugin_slug) DO NOTHING`,
      [slug, runtime],
    );
  }

  // Reported by the node as it works, so "downloading right now" is a state the
  // panel is told about rather than one it infers.
  public async recordNodeProgress(
    nodeId: string,
    progress: {
      slug: string;
      status: "Installing" | "Failed" | "Removing";
      version?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    const runtime = await this.pluginRuntime.getPluginRuntime();

    await this.postgres.query(
      `INSERT INTO public.game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, version, status, last_error,
          source, detected, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'managed', false, now())
       ON CONFLICT (game_server_node_id, plugin_slug) DO UPDATE SET
         status = EXCLUDED.status,
         version = COALESCE(EXCLUDED.version, game_server_node_plugins.version),
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        nodeId,
        progress.slug,
        runtime,
        progress.version ?? null,
        progress.status,
        progress.error ?? null,
      ],
    );
  }

  private async recordInstall(
    nodeId: string,
    slug: string,
    runtime: string,
    fields: {
      version: string;
      status: string;
      last_error: string | null;
      installed_at?: string;
    },
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO public.game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, version, status, last_error,
          installed_at, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'managed', now())
       ON CONFLICT (game_server_node_id, plugin_slug) DO UPDATE SET
         runtime = EXCLUDED.runtime,
         version = EXCLUDED.version,
         status = EXCLUDED.status,
         last_error = EXCLUDED.last_error,
         installed_at = COALESCE(EXCLUDED.installed_at, game_server_node_plugins.installed_at),
         source = 'managed',
         updated_at = now()`,
      [
        nodeId,
        slug,
        runtime,
        fields.version,
        fields.status,
        fields.last_error,
        fields.installed_at ?? null,
      ],
    );
  }

  private async getNodeIP(nodeId: string): Promise<string> {
    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: { id: nodeId },
        node_ip: true,
        status: true,
      },
    });

    if (!game_server_nodes_by_pk?.node_ip) {
      throw new NotFoundException(`Node ${nodeId} is not reachable`);
    }

    return game_server_nodes_by_pk.node_ip;
  }

  // Without this a node only notices on its own five minute poll, so pressing
  // Install looks like it did nothing. Deliberately not awaited: converging can
  // mean a multi-minute download, and the admin's action should not block on
  // it -- progress arrives through game_server_node_plugins, which the panel
  // subscribes to. A node that is down is not an error here; it converges on
  // its next poll.
  private nudgeNodes(): void {
    void (async () => {
      const nodes = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id FROM public.game_server_nodes
          WHERE enabled = true AND status IN ('Online', 'NotAcceptingNewMatches')`,
      );

      await Promise.all(
        nodes.map((node) =>
          this.callNode(node.id, "sync", { method: "POST" }).catch((error) => {
            this.logger.warn(
              `could not nudge ${node.id} to sync plugins: ${error.message ?? error}`,
            );
          }),
        ),
      );
    })().catch((error) => {
      this.logger.warn(`plugin nudge failed: ${error.message ?? error}`);
    });
  }

  private async callNode(
    nodeId: string,
    endpoint: string,
    options: RequestInit = {},
  ): Promise<unknown> {
    const nodeIP = await this.getNodeIP(nodeId);
    const url = `http://${nodeIP}:8585/plugins/${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      // Installing pulls an archive from the internet on the node's link.
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}) as { message?: string });
      throw new BadRequestException(
        body.message || `node connector returned ${response.status}`,
      );
    }

    return await response.json();
  }
}
