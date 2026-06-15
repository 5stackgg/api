import zlib from "zlib";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { S3Service } from "../s3/s3.service";
import { DemoParserService, ParsedDemo } from "./demo-parser.service";

export const DEMO_METADATA_VERSION = 4;

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

@Injectable()
export class DemoMetadataService {
  private readonly inFlight = new Map<string, Promise<DemoRow>>();

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
    private readonly demoParser: DemoParserService,
    private readonly config: ConfigService,
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

  public async ensureParsed(matchMapId: string): Promise<DemoRow> {
    const demo = await this.fetchDemoForMap(matchMapId);
    if (!demo) {
      throw new Error(`no uploaded demo for match_map ${matchMapId}`);
    }

    if (isDemoFresh(demo)) {
      return demo;
    }

    const existing = this.inFlight.get(demo.id);
    if (existing) {
      return existing;
    }

    const parsing = this.parseAndPersist(demo)
      .catch((error) => {
        this.logger.warn(
          `[demo-parser] parse failed for ${demo.id} — proceeding without round metadata: ${(error as Error)?.message}`,
        );
        return demo;
      })
      .finally(() => this.inFlight.delete(demo.id));
    this.inFlight.set(demo.id, parsing);
    return parsing;
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

  public async ensureParsedById(matchMapDemoId: string): Promise<void> {
    const demo = await this.fetchDemoById(matchMapDemoId);
    if (!demo) {
      this.logger.warn(
        `[demo-parser] ensureParsedById: no row for ${matchMapDemoId}`,
      );
      return;
    }

    if (isDemoFresh(demo)) {
      return;
    }

    const existing = this.inFlight.get(demo.id);
    if (existing) {
      await existing;
      return;
    }

    const parsing = this.parseAndPersist(demo)
      .catch((error) => {
        this.logger.warn(
          `[demo-parser] parse failed for ${demo.id}: ${(error as Error)?.message}`,
        );
        return demo;
      })
      .finally(() => this.inFlight.delete(demo.id));
    this.inFlight.set(demo.id, parsing);
    await parsing;
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

  public async persistParsed(
    matchMapDemoId: string,
    parsed: ParsedDemo,
  ): Promise<void> {
    const demo = await this.fetchDemoById(matchMapDemoId);

    await this.persistDemoStats(matchMapDemoId, demo?.match_id ?? null, parsed);

    await this.persistRanks(parsed, demo?.match_id ?? null);

    if (demo) {
      await this.uploadPlaybackBlob(
        demo.match_id,
        demo.match_map_id,
        demo.id,
        parsed,
        demo.playback_file,
      );
    }
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

  // Persists Valve ranks: Wingman (6), Competitive (7), Premier (11). Premier
  // is a global snapshot on the player row; Wingman/Competitive are per-map and
  // live only in the history table, tagged with map_id.
  public async persistRanks(
    parsed: ParsedDemo,
    matchId: string | null = null,
  ): Promise<void> {
    const RANK_TYPES = new Set([6, 7, 11]);
    const entries = (parsed.players ?? []).filter(
      (p) =>
        RANK_TYPES.has(Number(p.rank_type)) && (p.rank ?? 0) > 0 && p.steam_id,
    );
    if (entries.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    const steamIds = entries.map((e) => BigInt(e.steam_id).toString());
    const ranks = entries.map((e) => {
      const rank = Number(e.rank);
      if (!Number.isInteger(rank)) {
        throw new Error(`invalid rank for ${e.steam_id}: ${e.rank}`);
      }
      return rank;
    });
    const rankTypes = entries.map((e) => Number(e.rank_type));
    const previousRanks = entries.map((e) => {
      const pr = Number(e.previous_rank);
      return Number.isInteger(pr) && pr > 0 ? pr : null;
    });

    // Global snapshot — Premier only (Competitive/Wingman are per map).
    await this.postgres.query(
      `UPDATE public.players AS p
         SET premier_rank = v.rank,
             premier_rank_updated_at = $1::timestamptz
         FROM UNNEST($2::bigint[], $3::int[]) AS v(steam_id, rank)
         WHERE p.steam_id = v.steam_id
           AND (p.premier_rank_updated_at IS NULL OR p.premier_rank_updated_at <= $1::timestamptz)`,
      [
        now,
        steamIds.filter((_, i) => rankTypes[i] === 11),
        ranks.filter((_, i) => rankTypes[i] === 11),
      ],
    );
    if (matchId) {
      await this.postgres.query(
        `INSERT INTO public.player_premier_rank_history
           (steam_id, rank, rank_type, map_id, previous_rank, match_id, observed_at)
           SELECT v.steam_id, v.rank, v.rank_type,
             CASE WHEN v.rank_type = 11 THEN NULL ELSE mm.map_id END,
             COALESCE(
               v.previous_rank,
               (SELECT h.rank FROM public.player_premier_rank_history h
                 WHERE h.steam_id = v.steam_id AND h.rank_type = v.rank_type
                   AND h.match_id <> $1::uuid AND h.observed_at < $2::timestamptz
                   AND (v.rank_type = 11 OR h.map_id = mm.map_id)
                 ORDER BY h.observed_at DESC LIMIT 1)
             ),
             $1::uuid, $2::timestamptz
           FROM UNNEST($3::bigint[], $4::int[], $5::int[], $6::int[])
             AS v(steam_id, rank, rank_type, previous_rank)
           LEFT JOIN LATERAL (
             SELECT map_id FROM public.match_maps WHERE match_id = $1::uuid LIMIT 1
           ) mm ON true
           WHERE EXISTS (SELECT 1 FROM public.players WHERE steam_id = v.steam_id)
         ON CONFLICT (steam_id, match_id, rank_type) DO UPDATE
           SET rank = EXCLUDED.rank,
               map_id = EXCLUDED.map_id,
               previous_rank = EXCLUDED.previous_rank,
               observed_at = EXCLUDED.observed_at`,
        [matchId, now, steamIds, ranks, rankTypes, previousRanks],
      );
    }
    this.logger.log(`demo rank update wrote ${entries.length} players`);
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
             playback_size = $2::int
       WHERE id = $3::uuid`,
      [key, gz.byteLength, matchMapDemoId],
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
        `${blob.damages.length} damages)`,
    );
    return key;
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
    health: (p as { health?: number }).health ?? null,
    armor: (p as { armor?: number }).armor ?? null,
    helmet: (p as { helmet?: boolean }).helmet ?? false,
    has_bomb: p.has_bomb ?? false,
    has_defuser: p.has_defuser ?? false,
    active_weapon: (p as { active_weapon?: string }).active_weapon ?? null,
  }));

  const shots_fired = (parsed.shots_fired ?? []).map((s) => ({
    round: s.round ?? 0,
    tick: s.tick,
    attacker_steam_id: s.attacker ?? null,
    attacker_team: s.attacker_team ?? null,
    with: s.weapon ?? null,
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

  const damages = (parsed.damages ?? []).map((d) => ({
    round: d.round ?? 0,
    time: String(d.tick),
    attacker_steam_id: d.attacker ?? null,
    attacked_steam_id: d.victim ?? null,
    damage: d.damage,
    health: d.health ?? null,
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
    damages,
    round_inventory,
  };
}
