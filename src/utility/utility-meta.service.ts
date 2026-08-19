import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { DemoMetadataService } from "../demos/demo-metadata.service";
import { UtilityLineupsService } from "./utility-lineups.service";
import { MinedLineup, UtilityMiningService } from "./utility-mining.service";

// Bumping this re-mines every demo. Raise it whenever the derivation changes
// what it recovers -- a new technique, a corrected angle -- otherwise the fact
// table is a mix of two different readings of the same throws.
export const UTILITY_META_MINER_VERSION = 1;

type PendingDemo = {
  id: string;
  match_id: string | null;
  match_map_id: string | null;
  playback_file: string;
  map_name: string;
  thrown_at: Date | null;
};

@Injectable()
export class UtilityMetaService {
  // Each demo is a multi-MB inflate and a few hundred parabola fits. The job
  // runs hourly and the backlog is finite, so it takes a bite rather than
  // trying to swallow the archive in one pass.
  public static readonly DEMOS_PER_RUN = 25;

  // A demo that failed to mine is retried, but not on the next tick: a demo
  // whose blob is gone stays gone, and hammering S3 for it every hour is worse
  // than noticing it a day late.
  private static readonly RETRY_AFTER = "1 day";

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly lineups: UtilityLineupsService,
  ) {}

  public async mine(
    limit = UtilityMetaService.DEMOS_PER_RUN,
  ): Promise<{ demos: number; throws: number }> {
    // Inflating the archive hourly is a real cost on an install that turned the
    // library off, and nothing would ever read the result.
    if (!(await this.lineups.isLibraryEnabled())) {
      return { demos: 0, throws: 0 };
    }

    const demos = await this.pendingDemos(limit);

    if (demos.length === 0) {
      return { demos: 0, throws: 0 };
    }

    const maps = new Set<string>();
    let total = 0;

    for (const demo of demos) {
      try {
        const mined = await this.mineDemo(demo);
        total += mined;
        maps.add(demo.map_name);
      } catch (error) {
        const reason = (error as Error)?.message ?? String(error);
        this.logger.warn(`[utility-meta] ${demo.id} failed to mine: ${reason}`);
        await this.recordMine(demo.id, 0, reason.slice(0, 500));
      }
    }

    if (maps.size > 0) {
      await this.refreshClusters([...maps]);
    }

    this.logger.log(
      `[utility-meta] mined ${total} throw(s) from ${demos.length} demo(s) across ${maps.size} map(s)`,
    );

    return { demos: demos.length, throws: total };
  }

  private async pendingDemos(limit: number): Promise<Array<PendingDemo>> {
    return await this.postgres.query<Array<PendingDemo>>(
      `SELECT d.id::text AS id,
              d.match_id::text AS match_id,
              d.match_map_id::text AS match_map_id,
              d.playback_file,
              mp.name AS map_name,
              COALESCE(m.ended_at, m.created_at) AS thrown_at
         FROM public.match_map_demos d
         INNER JOIN public.match_maps mm ON mm.id = d.match_map_id
         INNER JOIN public.maps mp ON mp.id = mm.map_id
         LEFT JOIN public.matches m ON m.id = d.match_id
         LEFT JOIN public.utility_demo_mines mined ON mined.match_map_demo_id = d.id
        WHERE d.playback_file IS NOT NULL
          AND (
            mined.match_map_demo_id IS NULL
            OR mined.version < $1::int
            OR (
              mined.failed_reason IS NOT NULL
              AND mined.mined_at < now() - interval '${UtilityMetaService.RETRY_AFTER}'
            )
          )
        ORDER BY d.created_at DESC
        LIMIT $2::int`,
      [UTILITY_META_MINER_VERSION, limit],
    );
  }

  public async mineDemo(demo: PendingDemo): Promise<number> {
    const blob = await this.demoMetadata.readPlaybackBlob(demo.playback_file);
    const mined = UtilityMiningService.mineAll(
      blob,
      blob.map_name ?? demo.map_name,
    );

    await this.writeThrows(demo, mined);
    await this.recordMine(demo.id, mined.length, null);

    return mined.length;
  }

  private async writeThrows(
    demo: PendingDemo,
    mined: Array<MinedLineup>,
  ): Promise<void> {
    if (mined.length === 0) {
      return;
    }

    await this.postgres.query(
      `INSERT INTO public.utility_demo_throws
         (match_map_demo_id, grenade_id, match_id, match_map_id, map_name,
          utility_type, side, technique, throw_strength, thrower_steam_id,
          round, tick, origin_x, origin_y, origin_z,
          land_x, land_y, land_z, view_yaw, view_pitch, flight_time_ms,
          thrown_at)
       SELECT $1::uuid, v.grenade_id, $2::uuid, $3::uuid, $4,
              v.utility_type, v.side, v.technique, v.throw_strength, v.thrower_steam_id,
              v.round, v.tick, v.origin_x, v.origin_y, v.origin_z,
              v.land_x, v.land_y, v.land_z, v.view_yaw, v.view_pitch, v.flight_time_ms,
              $5::timestamptz
         FROM UNNEST(
                $6::int[], $7::text[], $8::text[], $9::text[], $10::text[],
                $11::bigint[], $12::int[], $13::int[],
                $14::float8[], $15::float8[], $16::float8[],
                $17::float8[], $18::float8[], $19::float8[],
                $20::float8[], $21::float8[], $22::int[]
              ) AS v(grenade_id, utility_type, side, technique, throw_strength,
                     thrower_steam_id, round, tick,
                     origin_x, origin_y, origin_z,
                     land_x, land_y, land_z,
                     view_yaw, view_pitch, flight_time_ms)
       ON CONFLICT (match_map_demo_id, grenade_id) DO UPDATE
          SET utility_type = EXCLUDED.utility_type,
              side = EXCLUDED.side,
              technique = EXCLUDED.technique,
              throw_strength = EXCLUDED.throw_strength,
              thrower_steam_id = EXCLUDED.thrower_steam_id,
              round = EXCLUDED.round,
              tick = EXCLUDED.tick,
              origin_x = EXCLUDED.origin_x,
              origin_y = EXCLUDED.origin_y,
              origin_z = EXCLUDED.origin_z,
              land_x = EXCLUDED.land_x,
              land_y = EXCLUDED.land_y,
              land_z = EXCLUDED.land_z,
              view_yaw = EXCLUDED.view_yaw,
              view_pitch = EXCLUDED.view_pitch,
              flight_time_ms = EXCLUDED.flight_time_ms`,
      [
        demo.id,
        demo.match_id,
        demo.match_map_id,
        mined[0].mapName,
        demo.thrown_at,
        mined.map((throwOf) => throwOf.grenadeId),
        mined.map((throwOf) => throwOf.utilityType),
        mined.map((throwOf) => throwOf.side),
        mined.map((throwOf) => throwOf.technique),
        mined.map((throwOf) => throwOf.throwStrength),
        mined.map((throwOf) => throwOf.throwerSteamId),
        mined.map((throwOf) => throwOf.round),
        mined.map((throwOf) => throwOf.throwTick),
        mined.map((throwOf) => throwOf.origin.x),
        mined.map((throwOf) => throwOf.origin.y),
        mined.map((throwOf) => throwOf.origin.z),
        mined.map((throwOf) => throwOf.land.x),
        mined.map((throwOf) => throwOf.land.y),
        mined.map((throwOf) => throwOf.land.z),
        mined.map((throwOf) => throwOf.viewYaw),
        mined.map((throwOf) => throwOf.viewPitch),
        mined.map((throwOf) => throwOf.flightTimeMs),
      ],
    );
  }

  private async recordMine(
    matchMapDemoId: string,
    throws: number,
    failedReason: string | null,
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO public.utility_demo_mines
         (match_map_demo_id, version, throws, failed_reason, mined_at)
       VALUES ($1::uuid, $2::int, $3::int, $4, now())
       ON CONFLICT (match_map_demo_id) DO UPDATE
          SET version = EXCLUDED.version,
              throws = EXCLUDED.throws,
              failed_reason = EXCLUDED.failed_reason,
              mined_at = EXCLUDED.mined_at`,
      [matchMapDemoId, UTILITY_META_MINER_VERSION, throws, failedReason],
    );
  }

  // Recomputes the clusters for the maps given, or for every map when given
  // none. The aggregate is stored rather than viewed because it is read on
  // every library browse and written once an hour -- and because PostgreSQL
  // cannot refresh a materialized view for one map, only for all of them.
  public async refreshClusters(
    mapNames: Array<string> | null = null,
  ): Promise<number> {
    const scope = mapNames && mapNames.length > 0 ? mapNames : null;

    const rows = await this.postgres.query<Array<{ lineup_bucket: string }>>(
      `INSERT INTO public.utility_meta_lineups
         (lineup_bucket, map_name, utility_type, side, technique, throw_strength,
          throws, throwers, matches, lineups,
          origin_x, origin_y, origin_z, land_x, land_y, land_z,
          view_yaw, view_pitch, first_seen_at, last_seen_at, refreshed_at)
       SELECT t.lineup_bucket,
              t.map_name,
              t.utility_type,
              mode() WITHIN GROUP (ORDER BY t.side),
              mode() WITHIN GROUP (ORDER BY t.technique),
              mode() WITHIN GROUP (ORDER BY t.throw_strength),
              COUNT(*)::int,
              COUNT(DISTINCT t.thrower_steam_id)::int,
              COUNT(DISTINCT t.match_id)::int,
              (SELECT COUNT(*)::int FROM public.utility_lineups l
                WHERE l.lineup_bucket = t.lineup_bucket),
              -- Medians, so one shanked throw in the bucket does not drag the
              -- representative spot off the pixel everyone else stands on.
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.origin_x),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.origin_y),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.origin_z),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.land_x),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.land_y),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.land_z),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.view_yaw),
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.view_pitch),
              MIN(t.thrown_at),
              MAX(t.thrown_at),
              now()
         FROM public.utility_demo_throws t
        WHERE ($1::text[] IS NULL OR t.map_name = ANY($1::text[]))
        GROUP BY t.lineup_bucket, t.map_name, t.utility_type
       ON CONFLICT (lineup_bucket) DO UPDATE
          SET map_name = EXCLUDED.map_name,
              utility_type = EXCLUDED.utility_type,
              side = EXCLUDED.side,
              technique = EXCLUDED.technique,
              throw_strength = EXCLUDED.throw_strength,
              throws = EXCLUDED.throws,
              throwers = EXCLUDED.throwers,
              matches = EXCLUDED.matches,
              lineups = EXCLUDED.lineups,
              origin_x = EXCLUDED.origin_x,
              origin_y = EXCLUDED.origin_y,
              origin_z = EXCLUDED.origin_z,
              land_x = EXCLUDED.land_x,
              land_y = EXCLUDED.land_y,
              land_z = EXCLUDED.land_z,
              view_yaw = EXCLUDED.view_yaw,
              view_pitch = EXCLUDED.view_pitch,
              first_seen_at = EXCLUDED.first_seen_at,
              last_seen_at = EXCLUDED.last_seen_at,
              refreshed_at = EXCLUDED.refreshed_at
       RETURNING lineup_bucket`,
      [scope],
    );

    // Deleting a match cascades its throws away; the cluster they made would
    // otherwise keep claiming twelve people run a lineup nobody threw.
    await this.postgres.query(
      `DELETE FROM public.utility_meta_lineups c
        WHERE ($1::text[] IS NULL OR c.map_name = ANY($1::text[]))
          AND NOT EXISTS (
            SELECT 1 FROM public.utility_demo_throws t
             WHERE t.lineup_bucket = c.lineup_bucket
          )`,
      [scope],
    );

    return rows.length;
  }
}
