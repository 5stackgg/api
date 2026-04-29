import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { DemoParserService } from "./demo-parser.service";

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

/**
 * Extracts demo metadata (header + round + kill + bomb events) and
 * writes it to `match_map_demos`. Used to be an out-of-cluster Go
 * microservice; now in-process via @laihoe/demoparser2 (Rust napi
 * binding) so there's one image to deploy.
 *
 * Idempotent: if `metadata_parsed_at` is already set on the row, we
 * skip the parse. Demos are immutable so the cache is permanent.
 */
@Injectable()
export class DemoMetadataService {
  // In-flight parses, keyed by match_map_demo_id. Avoids two
  // concurrent watchDemo calls from racing each other on the same
  // demo — the second caller awaits the first's Promise.
  private readonly inFlight = new Map<string, Promise<DemoRow>>();

  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly demoParser: DemoParserService,
  ) {}

  /**
   * Resolve the metadata-bearing demo row for a match_map_id. Triggers
   * a parse on first call; subsequent calls return the cached row.
   *
   * Best-effort by design: if the demo-parser microservice is down or
   * misconfigured, we log the failure and return the un-parsed row so
   * watchDemo can still spawn the playback session — the user just
   * loses round-jump until the next attempt. Pause / seek / speed
   * still work because they don't depend on round_ticks.
   */
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

  /**
   * Read-only accessor that does NOT trigger parsing. Used by the
   * watch-demo flow to inject `ROUND_TICKS` into the streamer pod env
   * if the parser has already run; an empty result just means the spec
   * server's /demo/round will 404 until a later refresh.
   */
  public async getDemoForMap(matchMapId: string): Promise<DemoRow | null> {
    return this.fetchDemoForMap(matchMapId);
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

  private async fetchDemoForMap(matchMapId: string): Promise<DemoRow | null> {
    const { match_map_demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: { match_map_id: { _eq: matchMapId } },
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
      } as any,
    });
    return (match_map_demos[0] as DemoRow) ?? null;
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
      } as any,
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
            map_name: parsed.map_name ?? null,
            workshop_id: parsed.workshop_id ?? null,
            cs2_build: parsed.cs2_build ?? null,
            metadata_parsed_at: "now()",
          } as any,
        },
        id: true,
      },
    });

    this.logger.log(
      `[demo-parser] parsed ${demo.id}: ${parsed.total_ticks} ticks @ ${parsed.tick_rate} tps, ${parsed.round_ticks?.length ?? 0} rounds, ${parsed.kills?.length ?? 0} kills, ${parsed.bombs?.length ?? 0} bombs, map=${parsed.map_name ?? "<unknown>"}${parsed.workshop_id ? ` (workshop ${parsed.workshop_id})` : ""}`,
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
}
