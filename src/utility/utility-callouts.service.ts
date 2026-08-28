import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";

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
  // Callouts are published beside the collision meshes under one CS2 build, so
  // this has to move with the browser's pin (web/nuxt.config.ts
  // public.mapMeshCdn) and the demo parser's default -- otherwise the panel and
  // the API can name the same throw differently after a map patch. Override
  // with MAP_MESH_CDN.
  private static readonly DEFAULT_CDN =
    "https://demo-dl.5stack.gg/maps/24957633";

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

  private readonly cache = new Map<string, CalloutRow[]>();

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
    if (cached) {
      return cached;
    }

    const rows = await this.postgres.query<Array<CalloutRow>>(
      `SELECT name, boxes
         FROM public.map_callouts
        WHERE map_name = $1`,
      [map],
    );

    this.cache.set(map, rows);
    return rows;
  }

  /**
   * Pull the published extract for one map. Best effort on purpose: the CDN is
   * not on the critical path of anything, and a jsDelivr blip must leave the
   * rows already in the table alone rather than emptying the table.
   */
  public async sync(mapName: string): Promise<number> {
    const map = UtilityCalloutsService.normalizeMapName(mapName);
    if (!map) {
      return 0;
    }

    const base = process.env.MAP_MESH_CDN || UtilityCalloutsService.DEFAULT_CDN;

    let callouts: MapCallout[];
    try {
      const response = await fetch(`${base}/${map}.callouts.json`);
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

  public async syncAll(): Promise<{ maps: number; callouts: number }> {
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
    await this.postgres.query(
      `DELETE FROM public.map_callouts
        WHERE map_name = $1
          AND source = $3
          AND name <> ALL($2::text[])`,
      [map, callouts.map(({ name }) => name), source],
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
