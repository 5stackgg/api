import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import {
  MapAssetsManifest,
  MapAssetsPointer,
  MapAssetsService,
} from "../map-assets/map-assets.service";

export type CalloutBox = {
  min: [number, number, number];
  max: [number, number, number];
};

export type MapCallout = {
  name: string;
  boxes: CalloutBox[];
};

export type CalloutPoint = {
  x: number;
  y: number;
  z?: number | null;
};

type CalloutRow = {
  name: string;
  boxes: CalloutBox[];
};

@Injectable()
export class UtilityCalloutsService {
  // Callouts resolve the same way the panel and the demo parser resolve meshes
  // (latest.json -> that build's manifest), otherwise the two can name the same
  // throw differently after a map patch. MAP_MESH_CDN pins a flat
  // <base>/<map>.callouts.json directory instead.
  private static readonly LATEST_TTL_MS = 10 * 60 * 1000;

  private static readonly LATEST_RETRY_MS = 30 * 1000;

  // How far outside every place volume a point may sit and still be named. The
  // volumes do not tile a map, and a grenade rests on top of geometry as often
  // as inside a place.
  public static readonly SNAP_UNITS = 256;

  private static readonly TYPE_LABELS: Record<string, string> = {
    Smoke: "Smoke",
    Flash: "Flash",
    Molotov: "Molotov",
    HighExplosive: "HE",
    Decoy: "Decoy",
  };

  private static readonly ALIASES: Record<string, string> = {
    bombsitea: "A Site",
    bombsiteb: "B Site",
    bombsitec: "C Site",
    tspawn: "T Spawn",
    ctspawn: "CT Spawn",
    terroristspawn: "T Spawn",
    counterterroristspawn: "CT Spawn",
  };

  // The cache is per PROCESS, and the sync that fills the table runs on one
  // replica. Without an expiry every other replica keeps answering from
  // whatever it read first -- and an empty answer is the one that matters,
  // because a replica that looked before the first sync landed would name every
  // throw after the map for the life of the process. `write` still invalidates
  // locally; this is what the replicas that did not do the writing rely on.
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  // A map with no callouts is a map still waiting for its extract, so it is
  // re-asked far sooner than one that answered.
  private static readonly EMPTY_CACHE_TTL_MS = 30 * 1000;

  private readonly cache = new Map<
    string,
    { rows: CalloutRow[]; expires: number }
  >();

  private latest: {
    manifest: MapAssetsManifest | null;
    build: string | null;
    expires: number;
  } = {
    manifest: null,
    build: null,
    expires: 0,
  };

  private readonly manifests = new Map<string, MapAssetsManifest>();

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {}

  /**
   * The one spelling every reader looks a map up by. A night variant is the
   * same geometry as its parent, so it shares its callouts rather than needing
   * its own extract.
   */
  public static normalizeMapName(name: string | null | undefined): string {
    const value = (name ?? "").toLowerCase().trim();
    const slash = value.lastIndexOf("/");
    return (slash >= 0 ? value.slice(slash + 1) : value).replace(/_night$/, "");
  }

  public async forMap(mapName: string): Promise<CalloutRow[]> {
    const map = UtilityCalloutsService.normalizeMapName(mapName);
    if (!map) {
      return [];
    }

    const cached = this.cache.get(map);
    if (cached && cached.expires > Date.now()) {
      return cached.rows;
    }

    const rows = await this.postgres.query<Array<CalloutRow>>(
      `SELECT name, boxes
         FROM public.map_callouts
        WHERE map_name = $1`,
      [map],
    );

    this.cache.set(map, {
      rows,
      expires:
        Date.now() +
        (rows.length
          ? UtilityCalloutsService.CACHE_TTL_MS
          : UtilityCalloutsService.EMPTY_CACHE_TTL_MS),
    });

    return rows;
  }

  /**
   * Pull the published extract for one map. Best effort on purpose: the CDN is
   * not on the critical path of anything, and a CDN blip must leave the rows
   * already in the table alone rather than emptying the table.
   */
  public async sync(mapName: string): Promise<number> {
    const map = UtilityCalloutsService.normalizeMapName(mapName);
    if (!map) {
      return 0;
    }

    let callouts: MapCallout[];
    try {
      const url = await this.calloutsUrl(map);
      if (!url) {
        return 0;
      }
      const response = await fetch(url);
      if (!response.ok) {
        return 0;
      }
      const body = (await response.json()) as { callouts?: MapCallout[] };
      callouts = UtilityCalloutsService.sanitize(body?.callouts);
    } catch (error) {
      this.logger.warn(
        `unable to fetch callouts for ${map}: ${(error as Error)?.message}`,
      );
      return 0;
    }

    if (!callouts.length) {
      return 0;
    }

    await this.write(map, callouts, "cdn");
    return callouts.length;
  }

  public async calloutsUrl(map: string): Promise<string | null> {
    const base = process.env.MAP_MESH_CDN;
    if (base) {
      return `${base}/${map}.callouts.json`;
    }

    return MapAssetsService.assetUrl(
      await this.latestManifest(),
      map,
      "callouts",
    );
  }

  // A failed refresh keeps serving the last manifest that loaded; only a
  // process that has never read latest.json falls back to the pinned build.
  // latest.json may name a manifest revision (<build>/manifest.r2.json), so its
  // key is followed as given.
  private async latestManifest(
    refresh = false,
  ): Promise<MapAssetsManifest | null> {
    if (!refresh && this.latest.expires > Date.now()) {
      return this.latest.manifest;
    }

    try {
      const pointer =
        await MapAssetsService.fetchIndex<MapAssetsPointer>("latest.json");
      if (pointer && pointer.version !== MapAssetsService.INDEX_VERSION) {
        throw new Error(`latest.json is version ${pointer.version}`);
      }
      if (!MapAssetsService.isSafeKey(pointer?.manifest)) {
        throw new Error("latest.json names no manifest");
      }

      let manifest = this.manifests.get(pointer.manifest);
      if (!manifest) {
        manifest = await MapAssetsService.fetchIndex<MapAssetsManifest>(
          pointer.manifest,
        );
        if (!manifest?.maps) {
          throw new Error(`${pointer.manifest} is not published`);
        }
        if (manifest.version !== MapAssetsService.INDEX_VERSION) {
          throw new Error(`${pointer.manifest} is version ${manifest.version}`);
        }
        this.manifests.set(pointer.manifest, manifest);
      }

      this.latest = {
        manifest,
        build: pointer.build,
        expires: Date.now() + UtilityCalloutsService.LATEST_TTL_MS,
      };
    } catch (error) {
      this.logger.warn(
        `unable to resolve the latest map assets: ${(error as Error)?.message}`,
      );
      this.latest = {
        ...this.latest,
        expires: Date.now() + UtilityCalloutsService.LATEST_RETRY_MS,
      };
    }

    return this.latest.manifest;
  }

  /**
   * Whether the published map assets have caught up with a CS2 build. A node
   * finishes its update long before the public instance has extracted and
   * published that build, and syncing in between only re-reads the previous
   * build's callouts.
   */
  public async hasPublished(buildId: number): Promise<boolean> {
    if (process.env.MAP_MESH_CDN) {
      return true;
    }

    await this.latestManifest(true);

    const published = Number(this.latest.build);
    return Number.isNaN(published) || published >= buildId;
  }

  public async syncAll(): Promise<{ maps: number; callouts: number }> {
    if (!process.env.MAP_MESH_CDN) {
      await this.latestManifest(true);
    }

    const maps = await this.postgres.query<Array<{ name: string }>>(
      `SELECT DISTINCT name
         FROM public.maps
        WHERE deleted_at IS NULL
          AND workshop_map_id IS NULL`,
    );

    let synced = 0;
    let total = 0;
    for (const { name } of maps) {
      const count = await this.sync(name);
      if (count > 0) {
        synced += 1;
        total += count;
      }
    }

    this.logger.log(`synced callouts for ${synced}/${maps.length} map(s)`);
    return { maps: synced, callouts: total };
  }

  /**
   * What a game server found in the map it just loaded. The published extract
   * wins wherever it exists -- it is deterministic and reviewable, where this
   * is whatever one server happened to report -- so this only ever fills a gap,
   * which in practice means workshop and community maps.
   */
  public async report(
    mapName: string,
    callouts: MapCallout[],
  ): Promise<{ stored: number }> {
    const map = UtilityCalloutsService.normalizeMapName(mapName);
    const clean = UtilityCalloutsService.sanitize(callouts);
    if (!map || !clean.length) {
      return { stored: 0 };
    }

    const [existing] = await this.postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count
         FROM public.map_callouts
        WHERE map_name = $1
          AND source = 'cdn'`,
      [map],
    );

    if (Number(existing?.count ?? 0) > 0) {
      return { stored: 0 };
    }

    await this.write(map, clean, "plugin");
    return { stored: clean.length };
  }

  /**
   * The name of the place a world point is in.
   *
   * XY containment is decided before Z because places stack: a smoke on a roof,
   * or in the air over a site, still belongs to the place beneath it. Z only
   * breaks ties, which is what keeps Nuke and Vertigo from answering with the
   * lower level's callout for a point on the upper one. Where volumes nest
   * ("A Site" containing "Goose") the tightest one wins -- the more specific
   * name is the one a player would say. See `area` for why that is measured in
   * three dimensions.
   */
  public static calloutAt(
    point: CalloutPoint | null | undefined,
    callouts: CalloutRow[],
    snap = UtilityCalloutsService.SNAP_UNITS,
  ): string | null {
    if (!point || !callouts?.length) {
      return null;
    }

    const x = Number(point.x);
    const y = Number(point.y);
    const z = Number(point.z ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    const inside: Array<{ name: string; box: CalloutBox }> = [];
    const above: Array<{ name: string; box: CalloutBox }> = [];
    let nearest: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const callout of callouts) {
      for (const box of callout.boxes ?? []) {
        if (!box?.min || !box?.max) {
          continue;
        }
        const inXY =
          x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1];
        if (inXY) {
          if (z >= box.min[2] && z <= box.max[2]) {
            inside.push({ name: callout.name, box });
          } else {
            above.push({ name: callout.name, box });
          }
          continue;
        }
        const distance = Math.sqrt(
          UtilityCalloutsService.gap(x, box.min[0], box.max[0]) ** 2 +
            UtilityCalloutsService.gap(y, box.min[1], box.max[1]) ** 2 +
            UtilityCalloutsService.gap(z, box.min[2], box.max[2]) ** 2,
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = callout.name;
        }
      }
    }

    if (inside.length) {
      return UtilityCalloutsService.smallest(inside);
    }

    if (above.length) {
      let best = above[0];
      let bestGap = UtilityCalloutsService.gap(z, best.box.min[2], best.box.max[2]);
      for (const candidate of above.slice(1)) {
        const gap = UtilityCalloutsService.gap(
          z,
          candidate.box.min[2],
          candidate.box.max[2],
        );
        if (
          gap < bestGap ||
          (gap === bestGap &&
            UtilityCalloutsService.area(candidate.box) <
              UtilityCalloutsService.area(best.box))
        ) {
          best = candidate;
          bestGap = gap;
        }
      }
      return best.name;
    }

    return nearestDistance <= snap ? nearest : null;
  }

  public static humanize(raw: string | null | undefined): string {
    const value = (raw ?? "").trim();
    if (!value) {
      return "";
    }

    const alias =
      UtilityCalloutsService.ALIASES[value.toLowerCase().replace(/[\s_]+/g, "")];
    if (alias) {
      return alias;
    }

    return (
      value
        .replace(/[_-]+/g, " ")
        // Valve glues a lowercase joining word between two capitalised ones --
        // TopofMid, BackofA. The camelCase rule below would read that as one
        // word and give "Topof Mid", so it is split first.
        .replace(/([a-z])of([A-Z])/g, "$1 of $2")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  /**
   * The name a throw would be given if nobody typed one. Empty when the map has
   * nothing to say about either end, so callers keep their own fallback rather
   * than being handed a name that says nothing.
   */
  public async autoName(
    mapName: string,
    utilityType: string,
    origin: CalloutPoint | null | undefined,
    landing: CalloutPoint | null | undefined,
  ): Promise<string> {
    const callouts = await this.forMap(mapName);
    if (!callouts.length) {
      return "";
    }

    const from = UtilityCalloutsService.humanize(
      UtilityCalloutsService.calloutAt(origin, callouts),
    );
    const to = UtilityCalloutsService.humanize(
      UtilityCalloutsService.calloutAt(landing, callouts),
    );
    const type = UtilityCalloutsService.TYPE_LABELS[utilityType] ?? utilityType;

    if (to && from) {
      return to === from ? `${to} ${type}` : `${to} ${type} from ${from}`;
    }
    if (to) {
      return `${to} ${type}`;
    }
    if (from) {
      return `${type} from ${from}`;
    }
    return "";
  }

  private async write(
    map: string,
    callouts: MapCallout[],
    source: "cdn" | "plugin",
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO public.map_callouts (map_name, name, boxes, source, updated_at)
       SELECT $1, entry->>'name', entry->'boxes', $3, now()
         FROM jsonb_array_elements($2::jsonb) AS entry
       ON CONFLICT (map_name, name) DO UPDATE
          SET boxes = EXCLUDED.boxes,
              source = EXCLUDED.source,
              updated_at = EXCLUDED.updated_at`,
      [map, JSON.stringify(callouts), source],
    );

    // A place Valve deleted in a patch has to go, or it keeps naming throws
    // after the area it named stopped existing.
    //
    // NOT scoped to the source being written. The extract wins wherever it
    // exists, so a name it does not carry must go even if a plugin reported it
    // first -- otherwise a map a practice server filled in before the extract
    // landed keeps its mis-read names for ever, mixed in with the real ones.
    // The reverse never arises: `report` no-ops entirely once any cdn row
    // exists, so a plugin write can only ever prune plugin rows.
    await this.postgres.query(
      `DELETE FROM public.map_callouts
        WHERE map_name = $1
          AND name <> ALL($2::text[])`,
      [map, callouts.map(({ name }) => name)],
    );

    this.cache.delete(map);
  }

  private static sanitize(callouts: MapCallout[] | undefined): MapCallout[] {
    const clean: MapCallout[] = [];

    for (const callout of (callouts ?? []).slice(0, 512)) {
      const name = String(callout?.name ?? "").trim().slice(0, 64);
      if (!name) {
        continue;
      }

      const boxes: CalloutBox[] = [];
      for (const box of (callout?.boxes ?? []).slice(0, 32)) {
        const min = UtilityCalloutsService.vec(box?.min);
        const max = UtilityCalloutsService.vec(box?.max);
        if (!min || !max) {
          continue;
        }
        boxes.push({
          min: [
            Math.min(min[0], max[0]),
            Math.min(min[1], max[1]),
            Math.min(min[2], max[2]),
          ],
          max: [
            Math.max(min[0], max[0]),
            Math.max(min[1], max[1]),
            Math.max(min[2], max[2]),
          ],
        });
      }

      if (boxes.length) {
        clean.push({ name, boxes });
      }
    }

    return clean;
  }

  private static vec(
    value: unknown,
  ): [number, number, number] | null {
    if (!Array.isArray(value) || value.length < 3) {
      return null;
    }
    const out = value.slice(0, 3).map(Number);
    return out.every((n) => Number.isFinite(n))
      ? (out as [number, number, number])
      : null;
  }

  private static gap(value: number, min: number, max: number): number {
    if (value < min) {
      return min - value;
    }
    if (value > max) {
      return value - max;
    }
    return 0;
  }

  /**
   * The tightest enclosing volume wins where places overlap. MEASURED, not
   * assumed: scored against `player_kills.attacker_location` (the engine's own
   * answer) over 1,920 labelled kills, smallest-volume beat smallest-footprint
   * 92.5% to 89.8%. Footprint alone loses the stacked pairs -- it called
   * Mirage's Catwalk "Underpass" 41 times, because Underpass sits under it and
   * is the narrower of the two seen from above.
   */
  private static area(box: CalloutBox): number {
    return (
      (box.max[0] - box.min[0]) *
      (box.max[1] - box.min[1]) *
      Math.max(box.max[2] - box.min[2], 1)
    );
  }

  private static smallest(
    candidates: Array<{ name: string; box: CalloutBox }>,
  ): string {
    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (
        UtilityCalloutsService.area(candidate.box) <
        UtilityCalloutsService.area(best.box)
      ) {
        best = candidate;
      }
    }
    return best.name;
  }
}
