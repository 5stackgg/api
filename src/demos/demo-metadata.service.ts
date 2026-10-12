import zlib from "zlib";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { S3Service } from "../s3/s3.service";
import { CacheService } from "../cache/cache.service";
import { DemoParserService, ParsedDemo } from "./demo-parser.service";

// The PLAYBACK BLOB's shape, not the parser's (ParsedDemo.schema_version).
// v10 adds `ducked` to positions and carries the parser's own version through.
// v11 adds `smoke_voxels` (each smoke as the game simulated it, parser schema
// 3+), `flashes`, and weapon / hitgroup / armor damage on `damages`.
// Every addition is additive, so a reader that tolerates unknown fields keeps
// working; a reader that pins an exact `schema_version` rejects every new blob.
export const DEMO_METADATA_VERSION = 11;

export type DemoRow = {
  id: string;
  match_id: string;
  match_map_id: string;
  file: string;
  playback_file: string | null;
  total_ticks: number | null;
  tick_rate: number | null;
  round_ticks: unknown;
  workshop_id: string | null;
  cs2_build: string | null;
  metadata_parsed_at: string | null;
};

// What lands in S3 and what readPlaybackBlob hands back. Derived from the
// builder so the two directions cannot drift apart.
export type PlaybackBlob = ReturnType<typeof buildPlaybackBlob>;

@Injectable()
export class DemoMetadataService {
  private readonly inFlight = new Map<string, Promise<DemoRow>>();
  private readonly blobsInFlight = new Map<string, Promise<PlaybackBlob>>();

  // A blob is multi-MB gzipped and several times that parsed, and gunzipSync
  // holds the whole thing in memory twice while it runs. Two at a time is the
  // difference between a slow read and an OOM on a pod that is also parsing.
  private static readonly MAX_CONCURRENT_INFLATE = 2;
  private static inflateInFlight = 0;
  private static readonly inflateWaiting: Array<() => void> = [];

  // Redis holds the parsed blob only long enough to cover a burst of reads
  // against one replay -- three lineups saved off one demo must not inflate it
  // three times -- not as a store.
  private static readonly PLAYBACK_BLOB_TTL_SECONDS = 60;
  // Past this the memo is worse than the work it saves: it would evict half of
  // Redis to hold something read a handful of times a minute.
  private static readonly PLAYBACK_BLOB_MAX_CACHE_BYTES = 48 * 1024 * 1024;

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
    private readonly demoParser: DemoParserService,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {}

  public static isExternalDemoUrl(file: string | null | undefined): boolean {
    return !!file && /^https?:\/\//i.test(file);
  }

  public async resolvePlayableDemoUrl(
    matchMapDemoId: string,
    expiresSeconds = 60 * 60,
  ): Promise<string> {
    const rows = await this.postgres.query<
      Array<{
        file: string | null;
        source: string;
        external_id: string | null;
      }>
    >(
      `SELECT d.file, m.source, m.external_id
         FROM public.match_map_demos d
         JOIN public.matches m ON m.id = d.match_id
        WHERE d.id = $1::uuid
        LIMIT 1`,
      [matchMapDemoId],
    );
    const row = rows.at(0);
    if (!row?.file) {
      throw new Error(`no demo file for demo ${matchMapDemoId}`);
    }
    const url = await this.resolveDemoFetchUrl(row.file, expiresSeconds, {
      source: row.source,
      externalId: row.external_id,
    });
    if (
      row.source !== "faceit" &&
      DemoMetadataService.isExternalDemoUrl(row.file) &&
      url !== row.file
    ) {
      await this.postgres.query(
        `UPDATE public.match_map_demos SET file = $2 WHERE id = $1::uuid`,
        [matchMapDemoId, url],
      );
    }
    return url;
  }

  public async resolveDemoFetchUrl(
    file: string,
    expiresSeconds = 60 * 60,
    context?: { source?: string | null; externalId?: string | null },
  ): Promise<string> {
    if (!DemoMetadataService.isExternalDemoUrl(file)) {
      return this.s3.getPresignedUrl(file, undefined, expiresSeconds, "get");
    }

    if (context?.source === "faceit") {
      const signed = await this.signFaceitDownloadUrl(file);
      if (signed) {
        return signed;
      }
      if (context.externalId) {
        const fresh = await this.refreshFaceitDemoUrl(context.externalId);
        const signedFresh = fresh
          ? await this.signFaceitDownloadUrl(fresh)
          : null;
        if (signedFresh) {
          return signedFresh;
        }
      }
      throw new Error(
        `faceit demo unavailable (downloads api key missing or match expired): ${context.externalId ?? file}`,
      );
    }

    if (await this.urlReachable(file)) {
      return file;
    }

    throw new Error(
      `demo no longer available at ${file}${context?.source ? ` (source=${context.source})` : ""}`,
    );
  }

  private async signFaceitDownloadUrl(
    resourceUrl: string,
  ): Promise<string | null> {
    const apiKey = this.config.get<string>("faceit.apiKey");
    if (!apiKey) {
      return null;
    }
    try {
      const res = await fetch(
        "https://open.faceit.com/download/v2/demos/download",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ resource_url: resourceUrl }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        this.logger.warn(
          `faceit downloads api ${res.status} for ${resourceUrl}`,
        );
        return null;
      }
      const data = (await res.json()) as {
        payload?: { download_url?: string };
      };
      return data.payload?.download_url ?? null;
    } catch (error) {
      this.logger.warn(
        `faceit downloads api failed for ${resourceUrl}: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  private async urlReachable(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403 || res.status === 404 || res.status === 410) {
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `demo url HEAD failed for ${url}: ${(error as Error)?.message ?? String(error)}`,
      );
      return true;
    }
  }

  private async fetchFaceitMatch(matchId: string): Promise<{
    demo_url?: string[];
    started_at?: number;
    finished_at?: number;
    teams?: Record<
      string,
      {
        roster?: Array<{
          game_player_id?: string;
          game_skill_level?: number;
        }>;
      }
    >;
  } | null> {
    const apiKey = this.config.get<string>("faceit.apiKey");
    if (!apiKey) {
      this.logger.warn(
        `cannot query faceit match ${matchId}: FACEIT_API_KEY not configured`,
      );
      return null;
    }
    try {
      const res = await fetch(
        `https://open.faceit.com/data/v4/matches/${encodeURIComponent(matchId)}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        this.logger.warn(`faceit match details ${res.status} for ${matchId}`);
        return null;
      }
      return await res.json();
    } catch (error) {
      this.logger.warn(
        `faceit match details failed for ${matchId}: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  private async refreshFaceitDemoUrl(matchId: string): Promise<string | null> {
    const data = await this.fetchFaceitMatch(matchId);
    return (data?.demo_url ?? []).find((url) => !!url) ?? null;
  }

  public async fetchFaceitMatchStartTime(
    matchId: string,
  ): Promise<string | null> {
    const data = await this.fetchFaceitMatch(matchId);
    const ts = data?.finished_at ?? data?.started_at ?? null;
    return ts ? new Date(ts * 1000).toISOString() : null;
  }

  public async getDemoForMap(matchMapId: string): Promise<DemoRow | null> {
    return this.fetchDemoForMap(matchMapId);
  }

  public async getDemoById(matchMapDemoId: string): Promise<DemoRow | null> {
    return this.fetchDemoById(matchMapDemoId);
  }

  public async getAllDemosForMap(matchMapId: string): Promise<DemoRow[]> {
    return this.fetchAllDemosForMap(matchMapId);
  }

  public async getAllDemosForMatch(matchId: string): Promise<DemoRow[]> {
    return this.fetchAllDemosForMatch(matchId);
  }

  public async ensureAllParsedForMap(matchMapId: string): Promise<DemoRow[]> {
    const demos = await this.fetchAllDemosForMap(matchMapId);
    if (demos.length === 0) return [];

    const results: DemoRow[] = [];
    for (const demo of demos) {
      if (isDemoFresh(demo)) {
        results.push(demo);
        continue;
      }
      const existing = this.inFlight.get(demo.id);
      if (existing) {
        results.push(await existing);
        continue;
      }
      const parsing = this.parseAndPersist(demo)
        .catch((error) => {
          this.logger.warn(
            `[demo-parser] parse failed for ${demo.id} during ensureAllParsedForMap: ${(error as Error)?.message}`,
          );
          return demo;
        })
        .finally(() => this.inFlight.delete(demo.id));
      this.inFlight.set(demo.id, parsing);
      results.push(await parsing);
    }
    return results;
  }

  // True only when this call is the one that parsed the demo. A demo that was
  // already parsed, one another caller is parsing, and a failed parse are all
  // false, so the caller can tell when the stats have just landed.
  public async ensureParsedById(matchMapDemoId: string): Promise<boolean> {
    const demo = await this.fetchDemoById(matchMapDemoId);
    if (!demo) {
      this.logger.warn(
        `[demo-parser] ensureParsedById: no row for ${matchMapDemoId}`,
      );
      return false;
    }

    if (isDemoFresh(demo)) {
      return false;
    }

    const existing = this.inFlight.get(demo.id);
    if (existing) {
      await existing;
      return false;
    }

    let parsed = true;
    const parsing = this.parseAndPersist(demo)
      .catch((error) => {
        parsed = false;
        this.logger.warn(
          `[demo-parser] parse failed for ${demo.id}: ${(error as Error)?.message}`,
        );
        return demo;
      })
      .finally(() => this.inFlight.delete(demo.id));
    this.inFlight.set(demo.id, parsing);
    await parsing;
    return parsed;
  }

  public async reparseById(matchMapDemoId: string): Promise<DemoRow> {
    const demo = await this.fetchDemoById(matchMapDemoId);
    if (!demo) {
      throw new Error(`no match_map_demo row for ${matchMapDemoId}`);
    }

    const existing = this.inFlight.get(demo.id);
    if (existing) {
      return existing;
    }

    const parsing = this.parseAndPersist(demo).finally(() =>
      this.inFlight.delete(demo.id),
    );
    this.inFlight.set(demo.id, parsing);
    return parsing;
  }

  private async fetchDemoForMap(matchMapId: string): Promise<DemoRow | null> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: { match_map_id: { _eq: matchMapId } },
          order_by: [{ metadata_parsed_at: "desc_nulls_last" }, { id: "desc" }],
          limit: 1,
        },
        id: true,
        match_id: true,
        match_map_id: true,
        file: true,
        playback_file: true,
        total_ticks: true,
        tick_rate: true,
        round_ticks: true,
        workshop_id: true,
        cs2_build: true,
        metadata_parsed_at: true,
      },
    });
    return (match_map_demos.at(0) as DemoRow) ?? null;
  }

  private async fetchAllDemosForMap(matchMapId: string): Promise<DemoRow[]> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: { match_map_id: { _eq: matchMapId } },
          order_by: [{ metadata_parsed_at: "desc_nulls_last" }, { id: "desc" }],
        },
        id: true,
        match_id: true,
        match_map_id: true,
        file: true,
        playback_file: true,
        total_ticks: true,
        tick_rate: true,
        round_ticks: true,
        workshop_id: true,
        cs2_build: true,
        metadata_parsed_at: true,
      },
    });
    return (match_map_demos as DemoRow[]) ?? [];
  }

  private async fetchAllDemosForMatch(matchId: string): Promise<DemoRow[]> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: { match_id: { _eq: matchId } },
          order_by: [{ match_map_id: "asc" }, { id: "desc" }],
        },
        id: true,
        match_id: true,
        match_map_id: true,
        file: true,
        playback_file: true,
        total_ticks: true,
        tick_rate: true,
        round_ticks: true,
        workshop_id: true,
        cs2_build: true,
        metadata_parsed_at: true,
      },
    });
    return (match_map_demos as DemoRow[]) ?? [];
  }

  private async fetchDemoById(matchMapDemoId: string): Promise<DemoRow | null> {
    const { match_map_demos_by_pk } = await this.hasura.query({
      match_map_demos_by_pk: {
        __args: { id: matchMapDemoId },
        id: true,
        match_id: true,
        match_map_id: true,
        file: true,
        playback_file: true,
        total_ticks: true,
        tick_rate: true,
        round_ticks: true,
        workshop_id: true,
        cs2_build: true,
        metadata_parsed_at: true,
      },
    });
    return (match_map_demos_by_pk as DemoRow) ?? null;
  }

  private async parseAndPersist(demo: DemoRow): Promise<DemoRow> {
    this.logger.log(
      `[demo-parser] parsing match_map_demo ${demo.id} (file=${demo.file})`,
    );
    const parsed = DemoMetadataService.isExternalDemoUrl(demo.file)
      ? await this.demoParser.parseFromUrl(demo.file)
      : await this.demoParser.parseFromS3Key(demo.file, demo.id);
    if (!parsed) {
      throw new Error(`demo parse returned null for ${demo.id}`);
    }

    await this.persistDemoStats(demo.id, demo.match_id, parsed);

    const playbackFile = await this.uploadPlaybackBlob(
      demo.match_id,
      demo.match_map_id,
      demo.id,
      parsed,
      demo.playback_file,
    );

    this.logger.log(
      `[demo-parser] parsed ${demo.id}: ${parsed.total_ticks} ticks @ ${parsed.tick_rate} tps, ${parsed.round_ticks?.length ?? 0} rounds, ${parsed.kills?.length ?? 0} kills, ${parsed.bombs?.length ?? 0} bombs, ${parsed.shots_fired?.length ?? 0} shots, ${parsed.damages?.length ?? 0} dmg, ${parsed.spotted?.length ?? 0} spotted, ${parsed.grenade_throws?.length ?? 0} thrown, ${parsed.grenade_detonations?.length ?? 0} detonated, map=${parsed.map_name ?? "<unknown>"}${parsed.workshop_id ? ` (workshop ${parsed.workshop_id})` : ""}`,
    );

    return {
      ...demo,
      total_ticks: parsed.total_ticks,
      tick_rate: parsed.tick_rate,
      round_ticks: parsed.round_ticks ?? [],
      workshop_id: parsed.workshop_id ?? null,
      cs2_build: parsed.cs2_build ?? null,
      metadata_parsed_at: new Date().toISOString(),
      playback_file: playbackFile,
    };
  }

  // Live 5stack matches get kills/rounds/money from in-game events, so a reparse
  // only re-derives demo-only aim stats. External matches have no live events, so
  // a reparse must re-run the full import to refresh kills/rounds/money/coords.
  private async persistDemoStats(
    matchMapDemoId: string,
    matchId: string | null,
    parsed: ParsedDemo,
  ): Promise<void> {
    const external = matchId ? await this.isExternalMatch(matchId) : false;
    const fn = external
      ? "public.persist_imported_demo"
      : "public.persist_parsed_demo";

    const kills = parsed.kills ?? [];
    const killsWithCoords = kills.filter((k) => k.attacker_x != null).length;
    const rounds = parsed.round_ticks ?? [];
    const roundsWithMoney = rounds.filter(
      (r) => r.ct_money != null || r.t_money != null,
    ).length;

    this.logger.log(
      `[persist] ${
        external
          ? "FULL import (external — wipes & re-inserts all stats)"
          : "PARTIAL import (5stack — aim stats only)"
      } match=${matchId ?? "<none>"} demo=${matchMapDemoId} via ${fn} | ` +
        `parsed kills=${kills.length} (with coords ${killsWithCoords}), ` +
        `rounds=${rounds.length} (with money ${roundsWithMoney})`,
    );

    const startedAt = Date.now();
    await this.postgres.query(`SELECT ${fn}($1::uuid, $2::jsonb)`, [
      matchMapDemoId,
      JSON.stringify(parsed),
    ]);
    this.logger.log(
      `[persist] done ${
        external ? "FULL" : "PARTIAL"
      } import match=${matchId ?? "<none>"} demo=${matchMapDemoId} in ${
        Date.now() - startedAt
      }ms`,
    );
  }

  private async isExternalMatch(matchId: string): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ source: string }>>(
      `SELECT source FROM public.matches WHERE id = $1::uuid LIMIT 1`,
      [matchId],
    );
    return (rows?.[0]?.source ?? "5stack") !== "5stack";
  }

  public async deleteDemo(matchMapDemoId: string): Promise<void> {
    const demo = await this.fetchDemoById(matchMapDemoId);
    if (!demo) {
      return;
    }
    if (!DemoMetadataService.isExternalDemoUrl(demo.file)) {
      try {
        await this.s3.removePrefix(demo.file);
      } catch (error) {
        this.logger.warn(
          `[demo-delete] failed to remove .dem ${demo.file}: ${(error as Error)?.message}`,
        );
      }
    }
    if (demo.playback_file) {
      try {
        await this.s3.removePrefix(demo.playback_file);
      } catch (error) {
        this.logger.warn(
          `[demo-delete] failed to remove playback blob ${demo.playback_file}: ${(error as Error)?.message}`,
        );
      }
    }
    await this.hasura.mutation({
      delete_match_map_demos_by_pk: {
        __args: { id: matchMapDemoId },
        __typename: true,
      },
    });
  }

  public async deleteDemosForMatch(matchId: string): Promise<void> {
    const removed = await this.s3.removePrefix(`demos/${matchId}/`);
    if (removed > 0) {
      this.logger.log(
        `[demo-delete] swept ${removed} object(s) under demos/${matchId}/`,
      );
    }

    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: { where: { match_id: { _eq: matchId } } },
        id: true,
      },
    });
    for (const demo of match_map_demos) {
      await this.hasura.mutation({
        delete_match_map_demos_by_pk: {
          __args: { id: demo.id },
          __typename: true,
        },
      });
    }
  }

  public async uploadPlaybackBlob(
    matchId: string,
    matchMapId: string,
    matchMapDemoId: string,
    parsed: ParsedDemo,
    prevPlaybackFile: string | null = null,
  ): Promise<string> {
    const key = playbackBlobKey(matchId, matchMapId, Date.now());
    const blob = buildPlaybackBlob(matchMapId, parsed);
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(blob)));
    await this.s3.put(key, gz);
    await this.postgres.query(
      `UPDATE public.match_map_demos
         SET playback_file = $1,
             playback_size = $2::int,
             playback_version = $3::int,
             parser_version = $4::int
       WHERE id = $5::uuid`,
      [
        key,
        gz.byteLength,
        DEMO_METADATA_VERSION,
        // Null when the parser did not report one, which is itself the answer:
        // it predates the schema being carried through at all.
        parsed.schema_version ?? null,
        matchMapDemoId,
      ],
    );
    if (prevPlaybackFile && prevPlaybackFile !== key) {
      try {
        await this.s3.remove(prevPlaybackFile);
      } catch (error) {
        this.logger.warn(
          `[playback-blob] failed to remove old blob ${prevPlaybackFile}: ${(error as Error)?.message}`,
        );
      }
    }
    this.logger.log(
      `[playback-blob] uploaded ${key} ` +
        `(${gz.byteLength} bytes gzipped, ` +
        `${blob.positions.length} positions, ` +
        `${blob.shots_fired.length} shots, ` +
        `${blob.grenade_throws.length} grenade events, ` +
        `${blob.smoke_volumes.length} smoke volumes, ` +
        `${blob.smoke_voxels.length} smoke voxel grids, ` +
        `${blob.infernos.length} infernos, ` +
        `${blob.damages.length} damages, ` +
        `${blob.flashes.length} flashes)`,
    );
    return key;
  }

  public static playbackBlobCacheKey(playbackFile: string): string {
    return `playback-blob:${playbackFile}`;
  }

  // The other half of uploadPlaybackBlob: same key, same shape, read back.
  // Anything that wants the events behind a replay -- mining a lineup, scoring
  // a clip -- goes through here rather than reaching into S3, so the version
  // and the compression live in one place.
  public async readPlaybackBlob(playbackFile: string): Promise<PlaybackBlob> {
    const cacheKey = DemoMetadataService.playbackBlobCacheKey(playbackFile);
    const cached = await this.cache.getRaw(cacheKey);

    if (cached) {
      return JSON.parse(cached) as PlaybackBlob;
    }

    const existing = this.blobsInFlight.get(playbackFile);

    if (existing) {
      return await existing;
    }

    const loading = this.loadPlaybackBlob(playbackFile, cacheKey);
    this.blobsInFlight.set(playbackFile, loading);

    try {
      return await loading;
    } finally {
      this.blobsInFlight.delete(playbackFile);
    }
  }

  private async loadPlaybackBlob(
    playbackFile: string,
    cacheKey: string,
  ): Promise<PlaybackBlob> {
    const stream = await this.s3.get(playbackFile);
    const chunks: Array<Buffer> = [];

    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    const gz = Buffer.concat(chunks);

    // The slot is held across the parse and the cache write, not just the
    // inflate: those are the other two full copies of the same document, and
    // releasing early puts an unbounded number of them in flight at once --
    // which is the spike the semaphore exists to stop. The string that was just
    // inflated is what goes to redis, so the blob is never re-serialised.
    await DemoMetadataService.acquireInflateSlot();

    let blob: PlaybackBlob;
    try {
      const json = zlib.gunzipSync(gz).toString("utf8");

      blob = JSON.parse(json) as PlaybackBlob;

      if (json.length <= DemoMetadataService.PLAYBACK_BLOB_MAX_CACHE_BYTES) {
        await this.cache.putRaw(
          cacheKey,
          json,
          DemoMetadataService.PLAYBACK_BLOB_TTL_SECONDS,
        );
      }
    } finally {
      DemoMetadataService.releaseInflateSlot();
    }

    return blob;
  }

  private static async acquireInflateSlot(): Promise<void> {
    while (
      DemoMetadataService.inflateInFlight >=
      DemoMetadataService.MAX_CONCURRENT_INFLATE
    ) {
      await new Promise<void>((resolve) => {
        DemoMetadataService.inflateWaiting.push(resolve);
      });
    }

    DemoMetadataService.inflateInFlight++;
  }

  private static releaseInflateSlot(): void {
    DemoMetadataService.inflateInFlight--;
    DemoMetadataService.inflateWaiting.shift()?.();
  }
}

function isDemoFresh(demo: DemoRow): boolean {
  return (
    !!demo.metadata_parsed_at &&
    !!demo.total_ticks &&
    !!demo.playback_file &&
    demo.playback_file.includes(`/playback.v${DEMO_METADATA_VERSION}.`)
  );
}

export function demoKey(matchId: string, mapId: string, demo: string): string {
  return `demos/${matchId}/${mapId}/${demo}`;
}

export function playbackBlobKey(
  matchId: string,
  matchMapId: string,
  cacheBuster: number,
): string {
  return `demos/${matchId}/${matchMapId}/playback/playback.v${DEMO_METADATA_VERSION}.${cacheBuster}.json.gz`;
}

function buildPlaybackBlob(matchMapId: string, parsed: ParsedDemo) {
  const positions = (parsed.positions ?? []).map((p) => ({
    round: p.round ?? 0,
    tick: p.tick,
    attacker_steam_id: p.attacker ?? null,
    attacker_team: p.team ?? null,
    alive: p.alive ?? false,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw ?? null,
    pitch: (p as { pitch?: number }).pitch ?? null,
    health: (p as { health?: number }).health ?? null,
    armor: (p as { armor?: number }).armor ?? null,
    helmet: (p as { helmet?: boolean }).helmet ?? false,
    has_bomb: p.has_bomb ?? false,
    has_defuser: p.has_defuser ?? false,
    active_weapon: (p as { active_weapon?: string }).active_weapon ?? null,
    ducked: p.ducked ?? false,
  }));

  const shots_fired = (parsed.shots_fired ?? []).map((s) => ({
    round: s.round ?? 0,
    tick: s.tick,
    attacker_steam_id: s.attacker ?? null,
    attacker_team: s.attacker_team ?? null,
    with: s.weapon ?? null,
    // Exact firing geometry + outcome so the 3D replay can draw a tracer
    // along the real shot direction, colored by hit / headshot / miss.
    yaw: s.yaw ?? null,
    pitch: s.pitch ?? null,
    eye_x: s.eye_x ?? null,
    eye_y: s.eye_y ?? null,
    eye_z: s.eye_z ?? null,
    result: s.result ?? null,
    impact_x: s.impact_x ?? null,
    impact_y: s.impact_y ?? null,
    impact_z: s.impact_z ?? null,
    // Where a missed round met world geometry, so the replay can stop the
    // tracer at the wall instead of flying it a fixed distance through it.
    miss_x: s.miss_x ?? null,
    miss_y: s.miss_y ?? null,
    miss_z: s.miss_z ?? null,
  }));

  const mapGrenade = (
    g: ParsedDemo["grenade_throws"][number],
    phase: string,
  ) => {
    const isThrow = phase === "thrown";
    return {
      round: g.round ?? 0,
      tick: g.tick,
      grenade_id: g.gid ?? null,
      thrower_steam_id: g.thrower ?? null,
      thrower_team: g.thrower_team ?? null,
      type: g.type,
      phase,
      x: (isThrow ? g.ox : g.x) ?? 0,
      y: (isThrow ? g.oy : g.y) ?? 0,
      z: (isThrow ? g.oz : g.z) ?? 0,
    };
  };
  const grenade_throws = [
    ...(parsed.grenade_throws ?? []).map((g) => mapGrenade(g, "thrown")),
    ...(parsed.grenade_detonations ?? []).map((g) =>
      mapGrenade(g, "detonated"),
    ),
  ];

  // The parser omits zero values, so an absent hitgroup is 0 (generic) and an
  // absent armor figure is no armor damage.
  const damages = (parsed.damages ?? []).map((d) => ({
    round: d.round ?? 0,
    time: String(d.tick),
    attacker_steam_id: d.attacker ?? null,
    attacked_steam_id: d.victim ?? null,
    weapon: d.weapon ?? null,
    hitgroup: d.hitgroup ?? 0,
    damage: d.damage,
    damage_armor: d.damage_armor ?? 0,
    health: d.health ?? null,
  }));

  const flashes = (parsed.flashes ?? []).map((f) => ({
    round: f.round ?? 0,
    tick: f.tick,
    attacker_steam_id: f.attacker ?? null,
    attacked_steam_id: f.victim ?? null,
    // Seconds of blindness.
    duration: f.duration ?? 0,
    team_flash: f.team_flash ?? false,
  }));

  const round_inventory = (parsed.round_inventory ?? []).map((r) => ({
    round: r.round ?? 0,
    steam_id: r.attacker ?? null,
    team: r.team ?? null,
    flash: r.flash ?? 0,
    smoke: r.smoke ?? 0,
    he: r.he ?? 0,
    molotov: r.molotov ?? 0,
    decoy: r.decoy ?? 0,
    primary: r.primary ?? null,
    secondary: r.secondary ?? null,
    armor: r.armor ?? 0,
    helmet: r.helmet ?? false,
    kit: r.kit ?? false,
  }));

  return {
    schema_version: DEMO_METADATA_VERSION,
    // Which parser produced the events below. Positions are ~4Hz except for a
    // full-rate burst around every grenade throw, and that burst only exists
    // from parser schema 2 -- a consumer deriving a lineup's standing spot has
    // to know whether it is looking at a 125ms-stale sample or a live one.
    parser_schema_version: parsed.schema_version ?? null,
    match_map_id: matchMapId,
    tick_rate: parsed.tick_rate,
    total_ticks: parsed.total_ticks,
    map_name: parsed.map_name ?? null,
    round_ticks: parsed.round_ticks ?? [],
    players: parsed.players ?? [],
    kills: parsed.kills ?? [],
    bombs: parsed.bombs ?? [],
    kit_drops: parsed.kit_drops ?? [],
    positions,
    shots_fired,
    grenade_throws,
    grenade_trajectories: parsed.grenade_trajectories ?? [],
    smoke_volumes: parsed.smoke_volumes ?? [],
    smoke_voxels: parsed.smoke_voxels ?? [],
    infernos: parsed.infernos ?? [],
    damages,
    flashes,
    round_inventory,
  };
}
