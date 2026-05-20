import zlib from "zlib";
import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { S3Service } from "../s3/s3.service";
import { DemoParserService, ParsedDemo } from "./demo-parser.service";

export type DemoRow = {
  id: string;
  match_id: string;
  match_map_id: string;
  file: string;
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
  ) {}

  public async ensureParsed(matchMapId: string): Promise<DemoRow> {
    const demo = await this.fetchDemoForMap(matchMapId);
    if (!demo) {
      throw new Error(`no uploaded demo for match_map ${matchMapId}`);
    }

    if (demo.metadata_parsed_at && demo.total_ticks) {
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
      if (demo.metadata_parsed_at && demo.total_ticks) {
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

    if (demo.metadata_parsed_at && demo.total_ticks) {
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
        total_ticks: true,
        tick_rate: true,
        round_ticks: true,
        workshop_id: true,
        cs2_build: true,
        metadata_parsed_at: true,
      },
    });
    return (match_map_demos[0] as DemoRow) ?? null;
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
    const parsed = await this.demoParser.parseFromS3Key(demo.file, demo.id);

    await this.postgres.query(
      `SELECT public.persist_parsed_demo($1::uuid, $2::jsonb)`,
      [demo.id, JSON.stringify(parsed)],
    );

    await this.uploadPlaybackBlob(
      demo.match_id,
      demo.match_map_id,
      demo.id,
      parsed,
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
    };
  }

  public async persistParsed(
    matchMapDemoId: string,
    parsed: ParsedDemo,
  ): Promise<void> {
    await this.postgres.query(
      `SELECT public.persist_parsed_demo($1::uuid, $2::jsonb)`,
      [matchMapDemoId, JSON.stringify(parsed)],
    );

    const demo = await this.fetchDemoById(matchMapDemoId);
    if (demo) {
      await this.uploadPlaybackBlob(
        demo.match_id,
        demo.match_map_id,
        demo.id,
        parsed,
      );
    }
  }

  public async deleteDemo(matchMapDemoId: string): Promise<void> {
    const demo = await this.fetchDemoById(matchMapDemoId);
    if (!demo) {
      return;
    }
    try {
      await this.s3.remove(demo.file);
    } catch (error) {
      this.logger.warn(
        `[demo-delete] failed to remove .dem ${demo.file}: ${(error as Error)?.message}`,
      );
    }
    const blobKey = playbackBlobKey(demo.match_id, demo.match_map_id);
    try {
      await this.s3.remove(blobKey);
    } catch (error) {
      this.logger.warn(
        `[demo-delete] failed to remove playback blob ${blobKey}: ${(error as Error)?.message}`,
      );
    }
    await this.hasura.mutation({
      delete_match_map_demos_by_pk: {
        __args: { id: matchMapDemoId },
        __typename: true,
      },
    });
  }

  private async uploadPlaybackBlob(
    matchId: string,
    matchMapId: string,
    matchMapDemoId: string,
    parsed: ParsedDemo,
  ): Promise<void> {
    const key = playbackBlobKey(matchId, matchMapId);
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
    this.logger.log(
      `[playback-blob] uploaded ${key} ` +
        `(${gz.byteLength} bytes gzipped, ` +
        `${blob.positions.length} positions, ` +
        `${blob.shots_fired.length} shots, ` +
        `${blob.grenade_throws.length} grenade events, ` +
        `${blob.damages.length} damages)`,
    );
  }
}

export function playbackBlobKey(matchId: string, matchMapId: string): string {
  return `${matchId}/${matchMapId}/playback/playback.json.gz`;
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
    schema_version: 1,
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
    damages,
    round_inventory,
  };
}
