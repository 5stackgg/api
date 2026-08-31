import { createHash } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { FileManagerService } from "../file-manager/file-manager.service";
import { PluginRuntimeService } from "../plugin-runtime/plugin-runtime.service";
import { CacheService } from "../cache/cache.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { RegistryIndex, RegistryPlugin } from "./types/Registry";
import { GamePluginQueues } from "./enums/GamePluginQueues";
import { NotifyGamePluginUpdate } from "./jobs/NotifyGamePluginUpdate";

@Injectable()
export class GamePluginsService {
  private static readonly DEFAULT_REGISTRY_URL = "https://registry.5stack.gg/";

  // Big enough for anything a CS2 plugin ships and small enough that a wrong
  // URL -- a disk image, a game build -- fails instead of filling the pod.
  private static readonly MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

  // One convergence interval plus room for a node that was mid-download when
  // the first report landed. PluginSyncService polls every five minutes.
  private static readonly NOTICE_GATHER_MS = 6 * 60 * 1000;

  private static readonly SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  private static readonly VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly pluginRuntime: PluginRuntimeService,
    private readonly cache: CacheService,
    @InjectQueue(GamePluginQueues.Registry)
    private readonly registryQueue: Queue,
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

    // A slug an operator added themselves is theirs. Overwriting it because the
    // catalog later publishes the same name would replace their download URL and
    // prune their versions out from under an install that is already running.
    const custom = new Set(
      (
        await this.postgres.query<Array<{ slug: string }>>(
          `SELECT slug FROM public.game_plugins WHERE source = 'custom'`,
        )
      ).map((row) => row.slug),
    );

    let versions = 0;

    for (const plugin of index.plugins) {
      if (custom.has(plugin.slug)) {
        this.logger.warn(
          `${plugin.slug} is now in the registry, but this deployment added its own; keeping theirs`,
        );
        continue;
      }

      versions += await this.upsertPlugin(plugin);
    }

    // A plugin pulled from the registry is only forgotten if nothing depends on
    // it. game_mode_plugins is RESTRICT, so deleting one a mode still selects
    // would abort the whole sync and leave the catalog half-applied.
    await this.postgres.query(
      `DELETE FROM public.game_plugins p
        WHERE p.source = 'registry'
          AND p.slug <> ALL($1::text[])
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
          hot_swappable, requires_service, requires_server_guidelines_disabled,
          config_schema, config_path, cvars, panel, wiring, pairs_with, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
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
         requires_server_guidelines_disabled = EXCLUDED.requires_server_guidelines_disabled,
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
        plugin.requires_server_guidelines_disabled ?? false,
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

  // A plugin the catalog does not carry. The operator points at a release and
  // this becomes an entry like any other -- installable, versioned, and
  // verified on the node against a digest, because the archive is hashed here
  // rather than trusted at download time.
  //
  // Kept in the same tables as the registry's own entries so nothing
  // downstream -- modes, node convergence, install state -- has to know the
  // difference. `source` is what keeps a sync from touching it.
  public async addCustomPlugin(input: {
    url: string;
    runtime: string;
    slug?: string;
    name?: string;
    description?: string;
    version?: string;
    layout?: string;
    installPath?: string;
  }): Promise<{
    slug: string;
    name: string;
    version: string;
    runtime: string;
  }> {
    const runtime = await this.assertRuntime(input.runtime);
    const layout = input.layout ?? "csgo";

    if (layout !== "csgo" && layout !== "plugin") {
      throw new BadRequestException(`unknown archive layout "${layout}"`);
    }

    if (layout === "plugin" && !input.installPath) {
      throw new BadRequestException(
        "an archive whose root is the plugin folder needs an install path",
      );
    }

    const resolved = await this.resolveCustomSource(input.url);

    const slug = (input.slug ?? resolved.slug ?? "").trim().toLowerCase();
    const version = (input.version ?? resolved.version ?? "").trim();

    if (!GamePluginsService.SLUG.test(slug)) {
      throw new BadRequestException(
        slug
          ? `"${slug}" is not a valid slug: lowercase letters, numbers and dashes`
          : "could not work out a slug from that URL; name the plugin yourself",
      );
    }

    if (!GamePluginsService.VERSION.test(version)) {
      throw new BadRequestException(
        version
          ? `"${version}" is not a valid version`
          : "could not work out a version from that URL; give it one yourself",
      );
    }

    const [existing] = await this.postgres.query<Array<{ source: string }>>(
      `SELECT source FROM public.game_plugins WHERE slug = $1`,
      [slug],
    );

    // Shadowing a catalog entry would leave two different downloads under one
    // name, and the sync would keep fighting over the row.
    if (existing && existing.source !== "custom") {
      throw new BadRequestException(
        `${slug} is already in the registry catalog; install it from there`,
      );
    }

    const { sha256, size } = await this.digestOf(resolved.download);

    await this.postgres.query(
      `INSERT INTO public.game_plugins
         (slug, kind, name, author, description, homepage, source, verified,
          synced_at)
       VALUES ($1, 'game', $2, $3, $4, $5, 'custom', false, now())
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         author = EXCLUDED.author,
         description = EXCLUDED.description,
         homepage = COALESCE(EXCLUDED.homepage, game_plugins.homepage),
         synced_at = now()`,
      [
        slug,
        input.name?.trim() || resolved.name || slug,
        resolved.author || "unknown",
        input.description?.trim() ||
          `Added by an administrator from ${resolved.homepage ?? resolved.download}`,
        resolved.homepage ?? null,
      ],
    );

    await this.postgres.query(
      `INSERT INTO public.game_plugin_versions
         (plugin_slug, runtime, version, url, sha256, size, published_at,
          prerelease, layout, install_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9)
       ON CONFLICT (plugin_slug, runtime, version) DO UPDATE SET
         url = EXCLUDED.url,
         sha256 = EXCLUDED.sha256,
         size = EXCLUDED.size,
         published_at = EXCLUDED.published_at,
         layout = EXCLUDED.layout,
         install_path = EXCLUDED.install_path`,
      [
        slug,
        runtime,
        version,
        resolved.download,
        sha256,
        size,
        resolved.publishedAt ?? new Date().toISOString(),
        layout,
        input.installPath?.trim() || null,
      ],
    );

    this.logger.log(`custom plugin ${slug}@${version} added for ${runtime}`);

    return {
      slug,
      name: input.name?.trim() || resolved.name || slug,
      version,
      runtime,
    };
  }

  private async assertRuntime(runtime: string): Promise<string> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.e_plugin_runtimes WHERE value = $1`,
      [runtime],
    );

    if (!row) {
      throw new BadRequestException(`unknown plugin runtime "${runtime}"`);
    }

    return row.value;
  }

  // Accepts what an operator actually has to hand: the repository, a release,
  // or the asset itself. A repository is worth resolving rather than refusing,
  // because "the newest Linux zip of the latest release" is the same choice the
  // registry build makes, and getting it wrong by hand is a silent failure to
  // load rather than an error.
  private async resolveCustomSource(url: string): Promise<{
    download: string;
    slug?: string;
    name?: string;
    author?: string;
    version?: string;
    homepage?: string;
    publishedAt?: string;
  }> {
    let parsed: URL;

    try {
      parsed = new URL(url.trim());
    } catch {
      throw new BadRequestException(`"${url}" is not a URL`);
    }

    // http:// would put the archive, and the digest that vouches for it, on the
    // wire in the clear.
    if (parsed.protocol !== "https:") {
      throw new BadRequestException("the URL has to be https");
    }

    const repo =
      parsed.hostname === "github.com"
        ? parsed.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/)
        : null;

    // A direct link to an asset, on GitHub or anywhere else.
    if (!repo || /\.(zip|tar\.gz|tgz)$/i.test(parsed.pathname)) {
      const file = parsed.pathname.split("/").pop() ?? "";
      const stem = file.replace(/\.(zip|tar\.gz|tgz)$/i, "");

      // A GitHub download URL carries the release tag, which is what the
      // release is actually called; the filename only sometimes agrees.
      const tag = parsed.pathname.match(/\/releases\/download\/([^/]+)\//)?.[1];

      return {
        download: parsed.toString(),
        slug: GamePluginsService.slugFrom(stem),
        name: stem || undefined,
        author: repo ? repo[1] : parsed.hostname,
        version:
          tag?.replace(/^v/, "") ??
          stem.match(/[-_v](\d+\.\d+(?:\.\d+)?)$/i)?.[1],
        homepage: repo ? `https://github.com/${repo[1]}/${repo[2]}` : undefined,
      };
    }

    const [, owner, name] = repo;
    const tag = parsed.pathname.match(/\/releases\/tag\/([^/]+)/)?.[1];

    const release = await this.githubRelease(`${owner}/${name}`, tag);
    const asset = GamePluginsService.selectReleaseAsset(release.assets ?? []);

    if (!asset) {
      throw new BadRequestException(
        `${owner}/${name} ${release.tag_name} publishes no Linux archive to install`,
      );
    }

    return {
      download: asset.browser_download_url,
      slug: GamePluginsService.slugFrom(name),
      name,
      author: owner,
      version: release.tag_name?.replace(/^v/, ""),
      homepage: `https://github.com/${owner}/${name}`,
      publishedAt: release.published_at,
    };
  }

  private async githubRelease(
    repo: string,
    tag?: string,
  ): Promise<{
    tag_name?: string;
    published_at?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  }> {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : "latest"}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "5stack-panel",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      throw new BadRequestException(
        response.status === 404
          ? `${repo} has no ${tag ? `release tagged ${tag}` : "published release"}`
          : `GitHub returned ${response.status} for ${repo}`,
      );
    }

    return await response.json();
  }

  // 5Stack game servers are Linux containers, and an asset built for another
  // platform unpacks perfectly well and then never loads. Same rule the registry
  // build applies, so a hand-added plugin behaves like a catalogued one.
  public static selectReleaseAsset(
    assets: Array<{ name: string; browser_download_url: string }>,
  ): { name: string; browser_download_url: string } | null {
    const archives = assets.filter((asset) => /\.zip$/i.test(asset.name));
    const portable = archives.filter(
      (asset) =>
        !/(^|[-_.])(win|win32|win64|windows|osx|macos|darwin)([-_.]|$)/i.test(
          asset.name,
        ),
    );

    return (
      portable.find((asset) =>
        /(^|[-_.])(linux|linuxsteamrt64)([-_.]|$)/i.test(asset.name),
      ) ??
      portable[0] ??
      null
    );
  }

  // A slug identifies the plugin, not the release, so the version has to come
  // off first -- otherwise every release installs as a different plugin.
  public static slugFrom(value: string): string | undefined {
    const slug = value
      .replace(/\.(zip|tar\.gz|tgz)$/i, "")
      .replace(/[-_.]?v?\d+(?:\.\d+)*$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    return GamePluginsService.SLUG.test(slug) ? slug : undefined;
  }

  // Hashed here, once, rather than trusted on each node: the digest is what
  // every node checks its download against, so it has to be established by
  // something that saw the bytes.
  private async digestOf(
    url: string,
  ): Promise<{ sha256: string; size: number }> {
    const response = await fetch(url, {
      headers: { "User-Agent": "5stack-panel" },
      redirect: "follow",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    if (!response.ok || !response.body) {
      throw new BadRequestException(
        `could not download ${url} (${response.status})`,
      );
    }

    const hash = createHash("sha256");
    let size = 0;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;

      if (size > GamePluginsService.MAX_ARCHIVE_BYTES) {
        throw new BadRequestException(
          `${url} is larger than ${Math.round(GamePluginsService.MAX_ARCHIVE_BYTES / 1024 / 1024)}MB; that is not a plugin`,
        );
      }

      hash.update(chunk);
    }

    if (size === 0) {
      throw new BadRequestException(`${url} returned an empty file`);
    }

    return { sha256: hash.digest("hex"), size };
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
      path?: string | null;
    }>,
  ): Promise<void> {
    for (const plugin of reported) {
      await this.postgres.query(
        `INSERT INTO public.game_server_node_plugins
           (game_server_node_id, plugin_slug, runtime, version, detected_version,
            source, detected, status, path, updated_at)
         SELECT n.id, $2,
                COALESCE($3::text, n.pin_plugin_runtime, active_plugin_runtime()),
                $4, $4, $5, true, 'Installed', $6, now()
           FROM public.game_server_nodes n
          WHERE n.id = $1
         ON CONFLICT (game_server_node_id, plugin_slug) DO UPDATE SET
           version = EXCLUDED.version,
           detected_version = EXCLUDED.detected_version,
           detected = true,
           status = 'Installed',
           source = EXCLUDED.source,
           runtime = EXCLUDED.runtime,
           path = EXCLUDED.path,
           last_error = null,
           updated_at = now()`,
        [
          nodeId,
          plugin.slug,
          plugin.runtime,
          plugin.version,
          plugin.source,
          plugin.path ?? null,
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
      content: isMarkdown ? this.absolutizeMarkdown(decoded, repo) : decoded,
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
    >(`SELECT homepage, panel FROM public.game_plugins WHERE slug = $1`, [
      slug,
    ]);

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
          -- Only when resolving the newest. Naming a version is an explicit
          -- choice and may well be a release candidate; tracking the newest is
          -- not, and a published rc would otherwise roll every node onto it on
          -- the next poll -- a release the update check does not even count.
          AND ($3::text IS NOT NULL OR prerelease = false)
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
    await this.postgres.query(
      `INSERT INTO public.game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, status, source, detected)
       SELECT n.id, $1, COALESCE(n.pin_plugin_runtime, active_plugin_runtime()),
              'Pending', 'managed', false
         FROM public.game_server_nodes n
        WHERE n.enabled = true
       ON CONFLICT (game_server_node_id, plugin_slug) DO NOTHING`,
      [slug],
    );
  }

  // Reported by the node as it works, so "downloading right now" is a state the
  // panel is told about rather than one it infers.
  public async recordNodeProgress(
    nodeId: string,
    progress: {
      slug: string;
      status: "Installing" | "Installed" | "Failed" | "Removing";
      version?: string | null;
      previousVersion?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    const previousVersion = await this.previousVersionFor(nodeId, progress);

    await this.postgres.query(
      `INSERT INTO public.game_server_node_plugins
         (game_server_node_id, plugin_slug, runtime, version, previous_version,
          status, last_error, source, detected, installed_at, updated_at)
       SELECT n.id, $2, COALESCE(n.pin_plugin_runtime, active_plugin_runtime()),
              $3, $6, $4, $5, 'managed', false,
              CASE WHEN $4 = 'Installed' THEN now() END, now()
         FROM public.game_server_nodes n
        WHERE n.id = $1
       ON CONFLICT (game_server_node_id, plugin_slug) DO UPDATE SET
         status = EXCLUDED.status,
         version = COALESCE(EXCLUDED.version, game_server_node_plugins.version),
         -- Installing opens an attempt and settles what it is replacing, so it
         -- overwrites -- including back to null, which is what a reinstall
         -- after an uninstall is. Every later report in the same attempt only
         -- fills the gap, so a Failed that names no previous version cannot
         -- erase the one the attempt started with.
         previous_version = CASE
           WHEN EXCLUDED.status = 'Installing' THEN EXCLUDED.previous_version
           ELSE COALESCE(
             EXCLUDED.previous_version, game_server_node_plugins.previous_version)
         END,
         runtime = EXCLUDED.runtime,
         last_error = EXCLUDED.last_error,
         installed_at = COALESCE(
           EXCLUDED.installed_at, game_server_node_plugins.installed_at),
         updated_at = now()`,
      [
        nodeId,
        progress.slug,
        progress.version ?? null,
        progress.status,
        progress.error ?? null,
        previousVersion,
      ],
    );

    await this.queueUpdateNotice(nodeId, { ...progress, previousVersion });
  }

  // A connector old enough not to send it still reports the version it is
  // moving to, and the row still holds the one it is moving from until this
  // statement overwrites it -- so the answer is here to be read. Without this
  // the whole feature is inert until every node in the fleet is upgraded.
  private async previousVersionFor(
    nodeId: string,
    progress: {
      slug: string;
      status: string;
      previousVersion?: string | null;
    },
  ): Promise<string | null> {
    if (progress.previousVersion !== undefined) {
      return progress.previousVersion;
    }

    if (progress.status !== "Installing" && progress.status !== "Failed") {
      return null;
    }

    const [row] = await this.postgres.query<
      Array<{ version: string | null; previous_version: string | null }>
    >(
      `SELECT version, previous_version FROM public.game_server_node_plugins
        WHERE game_server_node_id = $1 AND plugin_slug = $2`,
      [nodeId, progress.slug],
    );

    // Installing is the report that opens the attempt, so what the row still
    // holds is what is being replaced. By the time the attempt fails that has
    // already moved into previous_version and `version` is the build that did
    // not land.
    return (
      (progress.status === "Installing"
        ? row?.version
        : row?.previous_version) ?? null
    );
  }

  // Both outcomes of a version change are silent otherwise: an Auto install
  // moves with nobody asking it to, and a failed one leaves the node on the
  // build it already had while the panel says Failed to whoever happens to
  // open the page.
  //
  // Everything that decides *whether* to notify happens here rather than in
  // the job. A job that starts and then returns without sending still counts
  // as completed, and a completed job holds its id for the whole dedup window
  // -- so a decision made in there does not skip one notice, it suppresses
  // every later one for that release too.
  private async queueUpdateNotice(
    nodeId: string,
    progress: {
      slug: string;
      status: string;
      version?: string | null;
      previousVersion?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    if (!progress.version) {
      return;
    }

    const updated =
      progress.status === "Installed" &&
      !!progress.previousVersion &&
      progress.previousVersion !== progress.version;

    if (!updated && progress.status !== "Failed") {
      return;
    }

    try {
      const [install] = await this.postgres.query<
        Array<{ name: string; channel: string }>
      >(
        `SELECT p.name, i.channel
           FROM public.game_plugin_installs i
           INNER JOIN public.game_plugins p ON p.slug = i.plugin_slug
          WHERE i.plugin_slug = $1 AND i.enabled = true`,
        [progress.slug],
      );

      if (!install) {
        return;
      }

      // A pinned version only ever moves because an admin typed it, and they
      // do not need telling what they just did. A pinned install *failing* is
      // exactly as silent as an auto one, so that half is not filtered.
      if (updated && install.channel !== "Auto") {
        return;
      }

      const outcome = updated ? "updated" : "failed";
      const notice = `plugin-${outcome}.${progress.slug}.${progress.version}`;

      // Every node reports the same release separately. The first one to get
      // here books the notice; the rest add themselves to it while it sits in
      // its delay, which is what makes one notification cover a fleet.
      const jobId = await this.claim(notice, nodeId);

      if (!jobId) {
        return;
      }

      await this.registryQueue.add(
        NotifyGamePluginUpdate.name,
        {
          slug: progress.slug,
          name: install.name,
          version: progress.version,
          previousVersion: progress.previousVersion ?? null,
          error: progress.error ?? null,
          outcome,
          nodes: [nodeId],
        },
        {
          jobId,
          // Longer than a node's convergence interval on purpose. Nodes poll on
          // their own timers, so a release that breaks the fleet breaks it over
          // a five minute spread -- gathering for less than that names whichever
          // node was quickest and calls it the whole story.
          delay: GamePluginsService.NOTICE_GATHER_MS,
          // converge() retries a failing install every five minutes forever,
          // so without a window this long a bad release is a notification
          // every five minutes until somebody fixes it.
          removeOnComplete: { age: 7 * 24 * 60 * 60 },
          // A job that threw must not hold its id for the week: the id is what
          // suppresses the retry, and suppressing a notice nobody ever got is
          // the one outcome worse than a duplicate.
          removeOnFail: { age: 60 * 60 },
        },
      );
    } catch (error) {
      this.logger.warn(
        `could not queue the ${progress.slug} update notice: ${error.message ?? error}`,
      );
    }
  }

  // Which id this node should book the notice under, or null if it has nothing
  // new to say.
  //
  // getJob finds a completed job as readily as a waiting one, and updateData
  // succeeds against it -- so appending without checking edits a notice that
  // was sent minutes ago and nothing fires. That is the case that matters:
  // converge() retries forever, so a node that stays broken past the gathering
  // window would never be named at all, and the notice that did go out would
  // say one node while the fleet was down.
  private async claim(notice: string, nodeId: string): Promise<string | null> {
    const booked = await this.registryQueue.getJob(notice);

    if (!booked) {
      return notice;
    }

    const gathering = ["delayed", "waiting", "waiting-children", "paused"];

    if (gathering.includes(await booked.getState())) {
      await this.addNodeToNotice(booked, nodeId);
      return null;
    }

    // Already sent. A node that was in it has said all it has to say -- this is
    // the five minute retry, and swallowing it is the whole point of the
    // window. A node that was not is news, and gets a notice of its own on the
    // same throttle: add() is a no-op while that id is still held.
    if ((booked.data?.nodes ?? []).includes(nodeId)) {
      return null;
    }

    return `${notice}.${nodeId}`;
  }

  // Racy by nature -- two nodes can read the same job before either writes --
  // and deliberately left that way. Losing a node off the end of a list is a
  // worse notification; taking a lock to prevent it is a worse system.
  private async addNodeToNotice(job: Job, nodeId: string): Promise<void> {
    const nodes: Array<string> = job.data?.nodes ?? [];

    if (nodes.includes(nodeId)) {
      return;
    }

    await job.updateData({ ...job.data, nodes: [...nodes, nodeId] });
  }

  // Auto follows the newest release; Pinned stays where it is. Both columns
  // move together or the channel/version check rejects the row.
  //
  // Turning it off freezes at what the nodes actually report running, not at
  // the newest published build -- pinning to the latest would mean switching
  // auto updates *off* could roll the fleet forward, which is backwards.
  public async setAutoUpdate(slug: string, enabled: boolean): Promise<void> {
    const [install] = await this.postgres.query<Array<{ channel: string }>>(
      `SELECT channel FROM public.game_plugin_installs WHERE plugin_slug = $1`,
      [slug],
    );

    if (!install) {
      throw new BadRequestException(`${slug} is not installed`);
    }

    if (enabled) {
      await this.postgres.query(
        `UPDATE public.game_plugin_installs
            SET channel = 'Auto', version = null, updated_at = now()
          WHERE plugin_slug = $1`,
        [slug],
      );
    } else {
      await this.postgres.query(
        `UPDATE public.game_plugin_installs
            SET channel = 'Pinned', version = $2, updated_at = now()
          WHERE plugin_slug = $1`,
        [slug, await this.versionToPin(slug)],
      );
    }

    // Both directions, not just the one that rolls forward. Pinning down to an
    // older build is just as much a change for a node to converge to, and
    // without the nudge it sits there looking like the toggle did nothing
    // until the five minute poll comes round.
    this.nudgeNodes();
  }

  // What the fleet is on, preferring the version the most nodes report having
  // installed.
  //
  // The candidate has to have a build for every runtime in play, not just the
  // deployment default. desiredForNode drops a plugin it cannot resolve for a
  // node's runtime, and converge() uninstalls anything missing from what it is
  // sent -- so pinning to a version one runtime never published does not leave
  // those nodes behind, it wipes the plugin off them.
  private async versionToPin(slug: string): Promise<string> {
    const runtimes = await this.runtimesInPlay(slug);

    const [running] = await this.postgres.query<Array<{ version: string }>>(
      `SELECT p.version
         FROM public.game_server_node_plugins p
        WHERE p.plugin_slug = $1
          -- A hand-placed copy is not a version the panel can pin to: it is
          -- whatever an admin dropped on that one node, and it would win a
          -- vote it was never a candidate in.
          AND p.source = 'managed'
          AND p.version IS NOT NULL
          -- needed(runtime), not a bare alias: an unqualified runtime inside
          -- the inner query binds to the joined table's own column first, so
          -- the check compared a row to itself and passed for everything.
          AND NOT EXISTS (
                SELECT 1 FROM unnest($2::text[]) AS needed(runtime)
                 WHERE NOT EXISTS (
                       SELECT 1 FROM public.game_plugin_versions v
                        WHERE v.plugin_slug = p.plugin_slug
                          AND v.runtime = needed.runtime
                          AND v.version = p.version))
        GROUP BY p.version
        ORDER BY count(*) FILTER (
                   WHERE p.detected AND p.status = 'Installed') DESC,
                 count(*) DESC,
                 max(p.updated_at) DESC
        LIMIT 1`,
      [slug, runtimes],
    );

    if (running) {
      return running.version;
    }

    // Nothing has reported in yet -- a plugin requested minutes ago, or a
    // fleet that is entirely offline. The newest release every runtime in play
    // can actually install is the honest answer to "where are we".
    const [publishable] = await this.postgres.query<Array<{ version: string }>>(
      `SELECT v.version
         FROM public.game_plugin_versions v
        WHERE v.plugin_slug = $1
          AND NOT EXISTS (
                SELECT 1 FROM unnest($2::text[]) AS needed(runtime)
                 WHERE NOT EXISTS (
                       SELECT 1 FROM public.game_plugin_versions o
                        WHERE o.plugin_slug = v.plugin_slug
                          AND o.runtime = needed.runtime
                          AND o.version = v.version))
        GROUP BY v.version
        ORDER BY bool_or(v.prerelease) ASC, max(v.published_at) DESC
        LIMIT 1`,
      [slug, runtimes],
    );

    if (!publishable) {
      // Refusing is the correct answer rather than a failure to find one:
      // there is no version that would survive on every node, so there is
      // nothing to pin to that would not uninstall the plugin somewhere.
      throw new BadRequestException(
        runtimes.length > 1
          ? `${slug} has no single release published for every runtime running it (${runtimes.join(", ")}), so it cannot be pinned`
          : `${slug} has no release to pin to`,
      );
    }

    return publishable.version;
  }

  // Every runtime a node could ask this plugin for a build of, which is not the
  // same as the deployment default: a node can pin its own.
  //
  // Only the runtimes that already resolve the plugin count. One that has no
  // build of it at all is not a node the pin could strand -- desiredForNode
  // omits the plugin for it under Auto too, so those nodes have never had it
  // and nothing changes by pinning. Counting them anyway meant a single-runtime
  // plugin could not have auto updates turned off at all on a fleet where one
  // node runs the other framework.
  //
  // An empty list means nothing to satisfy, and the coverage clauses below
  // fall through rather than special-casing it.
  private async runtimesInPlay(slug: string): Promise<Array<string>> {
    const rows = await this.postgres.query<Array<{ runtime: string }>>(
      `SELECT DISTINCT COALESCE(n.pin_plugin_runtime, active_plugin_runtime())
                AS runtime
         FROM public.game_server_nodes n
        WHERE n.enabled = true
          AND EXISTS (
                SELECT 1 FROM public.game_plugin_versions v
                 WHERE v.plugin_slug = $1
                   AND v.runtime = COALESCE(
                         n.pin_plugin_runtime, active_plugin_runtime()))`,
      [slug],
    );

    return rows.map((row) => row.runtime);
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
      const body = await response.json().catch(() => ({}));
      throw new BadRequestException(
        FileManagerService.connectorErrorMessage(body) ||
          `node connector returned ${response.status}`,
      );
    }

    return await response.json();
  }
}
