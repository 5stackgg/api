import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import {
  DemoParserService,
  ParsedDemo,
  ParsedGrenadeEvent,
} from "./demo-parser.service";

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

    await this.hasura.mutation({
      update_match_map_demos_by_pk: {
        __args: {
          pk_columns: { id: demo.id },
          _set: {
            total_ticks: parsed.total_ticks,
            tick_rate: parsed.tick_rate,
            round_ticks: parsed.round_ticks ?? [],
            kills: parsed.kills ?? [],
            bombs: parsed.bombs ?? [],
            players: parsed.players ?? [],
            map_name: parsed.map_name ?? null,
            workshop_id: parsed.workshop_id ?? null,
            cs2_build: parsed.cs2_build ?? null,
            metadata_parsed_at: "now()",
          },
        },
        id: true,
      },
    });

    await this.persistDemoEvents(demo, parsed);
    await this.runRecompute(demo.match_map_id);

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

  // Demo-sourced events overwrite any prior demo parse for the same map
  // (live GSI never writes here, so we never clobber GSI rows). Delete →
  // bulk insert keeps the persisted set in sync with the latest parse.
  private async persistDemoEvents(
    demo: DemoRow,
    parsed: ParsedDemo,
  ): Promise<void> {
    const matchMapId = demo.match_map_id;
    const matchId = demo.match_id;

    await this.postgres.transaction(async (client) => {
      await client.query(
        `DELETE FROM public.player_shots_fired      WHERE match_map_id = $1`,
        [matchMapId],
      );
      await client.query(
        `DELETE FROM public.player_spotted          WHERE match_map_id = $1`,
        [matchMapId],
      );
      await client.query(
        `DELETE FROM public.player_grenade_throws   WHERE match_map_id = $1`,
        [matchMapId],
      );
      await client.query(
        `DELETE FROM public.player_aim_stats_demo   WHERE match_map_id = $1`,
        [matchMapId],
      );

      const CHUNK = 1000;

      const shots = (parsed.shots_fired ?? []).filter((r) => r.attacker);
      for (let i = 0; i < shots.length; i += CHUNK) {
        const slice = shots.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const tuples = slice.map((row, idx) => {
          const base = idx * 7;
          values.push(
            matchId,
            matchMapId,
            row.round ?? 0,
            row.tick,
            BigInt(row.attacker as string),
            row.attacker_team ?? null,
            row.weapon ?? null,
          );
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
        });
        await client.query(
          `INSERT INTO public.player_shots_fired
             (match_id, match_map_id, round, tick, attacker_steam_id, attacker_team, "with")
           VALUES ${tuples.join(",")}`,
          values,
        );
      }

      type AimAgg = {
        hits: number;
        headshot_hits: number;
        counter_strafed_shots: number;
        crosshair_sum: number;
        crosshair_count: number;
        firstDamageByRound: Map<number, number>;
      };
      const aim = new Map<string, AimAgg>();
      const getAgg = (sid: string): AimAgg => {
        let a = aim.get(sid);
        if (!a) {
          a = {
            hits: 0,
            headshot_hits: 0,
            counter_strafed_shots: 0,
            crosshair_sum: 0,
            crosshair_count: 0,
            firstDamageByRound: new Map(),
          };
          aim.set(sid, a);
        }
        return a;
      };
      for (const s of parsed.shots_fired ?? []) {
        if (!s.attacker) continue;
        const a = getAgg(s.attacker);
        if (s.counter_strafed) a.counter_strafed_shots += 1;
        if (typeof s.crosshair_angle_deg === "number") {
          a.crosshair_sum += s.crosshair_angle_deg;
          a.crosshair_count += 1;
        }
      }
      for (const d of parsed.damages ?? []) {
        if (!d.attacker || !d.victim) continue;
        if (d.attacker_team && d.attacker_team === d.victim_team) continue;
        const a = getAgg(d.attacker);
        a.hits += 1;
        // demoinfocs HitGroup 1 = Head.
        if (d.hitgroup === 1) a.headshot_hits += 1;
        const round = d.round ?? 0;
        const srs = Math.max(0, d.since_round_start ?? 0);
        const cur = a.firstDamageByRound.get(round);
        if (cur === undefined || srs < cur)
          a.firstDamageByRound.set(round, srs);
      }
      const aimRows = Array.from(aim.entries()).map(([attacker, a]) => {
        let ttdSum = 0;
        for (const v of a.firstDamageByRound.values()) ttdSum += v;
        return {
          attacker,
          hits: a.hits,
          headshot_hits: a.headshot_hits,
          counter_strafed_shots: a.counter_strafed_shots,
          crosshair_angle_sum_deg: a.crosshair_sum,
          crosshair_angle_count: a.crosshair_count,
          time_to_damage_sum_s: ttdSum,
          time_to_damage_count: a.firstDamageByRound.size,
        };
      });
      for (let i = 0; i < aimRows.length; i += CHUNK) {
        const slice = aimRows.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const tuples = slice.map((row, idx) => {
          const base = idx * 10;
          values.push(
            matchId,
            matchMapId,
            BigInt(row.attacker),
            row.hits,
            row.headshot_hits,
            row.counter_strafed_shots,
            row.crosshair_angle_sum_deg,
            row.crosshair_angle_count,
            row.time_to_damage_sum_s,
            row.time_to_damage_count,
          );
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
        });
        await client.query(
          `INSERT INTO public.player_aim_stats_demo
             (match_id, match_map_id, attacker_steam_id,
              hits, headshot_hits,
              counter_strafed_shots, crosshair_angle_sum_deg, crosshair_angle_count,
              time_to_damage_sum_s, time_to_damage_count)
           VALUES ${tuples.join(",")}`,
          values,
        );
      }

      // Defensive: drop rows with missing spotter/spotted (the demo parser
      // shouldn't emit them, but the columns are NOT NULL).
      const spotted = (parsed.spotted ?? []).filter(
        (r) => r.spotter && r.spotted,
      );
      for (let i = 0; i < spotted.length; i += CHUNK) {
        const slice = spotted.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const tuples = slice.map((row, idx) => {
          const base = idx * 7;
          values.push(
            matchId,
            matchMapId,
            row.round ?? 0,
            row.tick,
            BigInt(row.spotter as string),
            BigInt(row.spotted as string),
            row.spotter_team ?? null,
          );
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
        });
        await client.query(
          `INSERT INTO public.player_spotted
             (match_id, match_map_id, round, tick, spotter_steam_id, spotted_steam_id, spotter_team)
           VALUES ${tuples.join(",")}`,
          values,
        );
      }

      const throws: Array<
        ParsedGrenadeEvent & { phase: "thrown" | "detonated" }
      > = [
        ...(parsed.grenade_throws ?? []).map((g) => ({
          ...g,
          phase: "thrown" as const,
        })),
        ...(parsed.grenade_detonations ?? []).map((g) => ({
          ...g,
          phase: "detonated" as const,
        })),
      ];
      for (let i = 0; i < throws.length; i += CHUNK) {
        const slice = throws.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const tuples = slice.map((row, idx) => {
          const base = idx * 11;
          // Throws carry ox/oy/oz; detonations carry x/y/z. We collapse
          // both into one set of position columns since the meaning
          // (point of interest at the recorded tick) is the same.
          const px = row.phase === "thrown" ? row.ox : row.x;
          const py = row.phase === "thrown" ? row.oy : row.y;
          const pz = row.phase === "thrown" ? row.oz : row.z;
          values.push(
            matchId,
            matchMapId,
            row.round ?? 0,
            row.tick,
            row.thrower ? BigInt(row.thrower) : null,
            row.thrower_team ?? null,
            row.type,
            row.phase,
            px ?? null,
            py ?? null,
            pz ?? null,
          );
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`;
        });
        await client.query(
          `INSERT INTO public.player_grenade_throws
             (match_id, match_map_id, round, tick, thrower_steam_id, thrower_team, type, phase, x, y, z)
           VALUES ${tuples.join(",")}`,
          values,
        );
      }
    });
  }

  private async runRecompute(matchMapId: string): Promise<void> {
    try {
      await this.postgres.query(
        `SELECT public.recompute_player_match_map_stats($1::uuid)`,
        [matchMapId],
      );
    } catch (error) {
      this.logger.warn(
        `[demo-parser] recompute failed for match_map ${matchMapId}: ${(error as Error)?.message}`,
      );
    }
  }
}
