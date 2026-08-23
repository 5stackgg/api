import zlib from "zlib";
import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { S3Service } from "../s3/s3.service";
import type { UtilityTrajectoryBlob } from "./utility-artifacts.service";

// Recovers the launch seed a live recording should have carried.
//
// The plugin records the whole flight but only ever writes initial_position /
// initial_velocity out of the solver, so every lineup saved from a real throw
// has a full trajectory and no seed -- which is the one thing that makes it
// unrenderable. The flight is the measurement, though: two consecutive samples
// give the velocity that produced them, and the seed is that velocity walked
// back to the first sample. Nothing here models the engine.

export type LaunchSeedVector = { x: number; y: number; z: number };

export type DerivedLaunchSeed = {
  position: LaunchSeedVector;
  velocity: LaunchSeedVector;
  // The acceleration the samples actually show. Reported rather than assumed so
  // a caller can see gravity in the number instead of trusting the derivation
  // blind -- a plausible z here is the whole sanity check.
  acceleration: LaunchSeedVector;
};

export type LaunchSeedBackfillResult = {
  scanned: number;
  seeded: number;
  skipped: number;
  done: boolean;
};

type BackfillRow = {
  id: string;
  name: string | null;
  trajectory_file: string;
};

type TrajectoryPoint = { tick: number; x: number; y: number; z: number };

@Injectable()
export class UtilityLaunchSeedService {
  // One batch per call, like the meta re-mine: each lineup is an S3 read, and a
  // caller that can watch it progress beats a request held open across the
  // whole library.
  public static readonly BATCH = 50;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
  ) {}

  /**
   * Free flight is constant acceleration, so three samples are enough and none
   * of it depends on knowing sv_gravity.
   *
   * A difference quotient over [a, b] is the instantaneous velocity at the
   * midpoint, not at either end -- taking it for the velocity at `a` is what
   * would bake half a tick of gravity into the seed. So: two quotients, the
   * acceleration between their midpoints, then walk the first one back to the
   * first sample.
   */
  public static derive(
    points: Array<TrajectoryPoint>,
    tickRate: number,
  ): DerivedLaunchSeed | null {
    if (!Number.isFinite(tickRate) || tickRate <= 0 || points.length < 3) {
      return null;
    }

    const [p0, p1, p2] = points;

    if (!(p1.tick > p0.tick) || !(p2.tick > p1.tick)) {
      return null;
    }

    const dt01 = (p1.tick - p0.tick) / tickRate;
    const dt12 = (p2.tick - p1.tick) / tickRate;
    // Midpoint of the second window minus midpoint of the first.
    const span = (p2.tick - p0.tick) / (2 * tickRate);

    const v01 = UtilityLaunchSeedService.scale(
      UtilityLaunchSeedService.subtract(p1, p0),
      1 / dt01,
    );
    const v12 = UtilityLaunchSeedService.scale(
      UtilityLaunchSeedService.subtract(p2, p1),
      1 / dt12,
    );

    const acceleration = UtilityLaunchSeedService.scale(
      UtilityLaunchSeedService.subtract(v12, v01),
      1 / span,
    );

    const velocity = UtilityLaunchSeedService.subtract(
      v01,
      UtilityLaunchSeedService.scale(acceleration, dt01 / 2),
    );

    const position = { x: p0.x, y: p0.y, z: p0.z };

    if (
      !UtilityLaunchSeedService.finite(position) ||
      !UtilityLaunchSeedService.finite(velocity) ||
      !UtilityLaunchSeedService.finite(acceleration)
    ) {
      return null;
    }

    // A seed with no speed is the one thing hasSeed() still rejects, so it is
    // not worth writing.
    if (Math.hypot(velocity.x, velocity.y, velocity.z) <= 0) {
      return null;
    }

    return { position, velocity, acceleration };
  }

  public async backfill(
    limit: number = UtilityLaunchSeedService.BATCH,
  ): Promise<LaunchSeedBackfillResult> {
    const rows = await this.postgres.query<Array<BackfillRow>>(
      `SELECT id::text AS id, name, trajectory_file
         FROM public.utility_lineups
        WHERE trajectory_file IS NOT NULL
          AND (initial_pos_x IS NULL OR initial_vel_x IS NULL)
        ORDER BY created_at ASC
        LIMIT $1::int`,
      [limit],
    );

    let seeded = 0;
    let skipped = 0;

    for (const row of rows) {
      const seed = await this.seedFor(row);

      if (!seed) {
        skipped++;
        continue;
      }

      await this.write(row.id, seed);
      seeded++;

      this.logger.log(
        `[utility-launch-seed] ${row.id} (${row.name ?? "unnamed"}): ` +
          `v=(${seed.velocity.x.toFixed(1)}, ${seed.velocity.y.toFixed(1)}, ` +
          `${seed.velocity.z.toFixed(1)}) ` +
          `|v|=${Math.hypot(seed.velocity.x, seed.velocity.y, seed.velocity.z).toFixed(1)} ` +
          `a.z=${seed.acceleration.z.toFixed(1)}`,
      );
    }

    return {
      scanned: rows.length,
      seeded,
      skipped,
      // A short batch is the last batch; the caller stops asking.
      done: rows.length < limit,
    };
  }

  public async backfillOne(lineupId: string): Promise<DerivedLaunchSeed | null> {
    const [row] = await this.postgres.query<Array<BackfillRow>>(
      `SELECT id::text AS id, name, trajectory_file
         FROM public.utility_lineups
        WHERE id = $1::uuid AND trajectory_file IS NOT NULL`,
      [lineupId],
    );

    if (!row) {
      return null;
    }

    const seed = await this.seedFor(row);

    if (seed) {
      await this.write(row.id, seed);
    }

    return seed;
  }

  private async seedFor(row: BackfillRow): Promise<DerivedLaunchSeed | null> {
    const points = await this.points(row);

    if (!points) {
      return null;
    }

    const seed = UtilityLaunchSeedService.derive(points.path, points.tickRate);

    if (!seed) {
      this.logger.warn(
        `[utility-launch-seed] ${row.id}: ${points.path.length} points @ ` +
          `${points.tickRate}tps did not yield a seed`,
      );
    }

    return seed;
  }

  private async points(
    row: BackfillRow,
  ): Promise<{ path: Array<TrajectoryPoint>; tickRate: number } | null> {
    try {
      const stream = await this.s3.get(row.trajectory_file);
      const chunks: Array<Buffer> = [];

      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }

      const blob = JSON.parse(
        zlib.gunzipSync(Buffer.concat(chunks)).toString(),
      ) as UtilityTrajectoryBlob;

      const trajectory = blob?.grenade_trajectories?.at(0);
      const path = (trajectory?.points ?? []) as Array<TrajectoryPoint>;

      if (path.length < 3) {
        return null;
      }

      return { path, tickRate: Number(blob?.tick_rate) };
    } catch (error) {
      this.logger.warn(
        `[utility-launch-seed] unable to read ${row.trajectory_file}: ` +
          `${(error as Error)?.message}`,
      );
      return null;
    }
  }

  // Only ever fills a hole. A lineup the solver has already seeded is the
  // authority on its own throw -- a derived seed must never overwrite one that
  // was measured against the engine.
  private async write(
    lineupId: string,
    seed: DerivedLaunchSeed,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_lineups
          SET initial_pos_x = $2, initial_pos_y = $3, initial_pos_z = $4,
              initial_vel_x = $5, initial_vel_y = $6, initial_vel_z = $7
        WHERE id = $1::uuid
          AND (initial_pos_x IS NULL OR initial_vel_x IS NULL)`,
      [
        lineupId,
        seed.position.x,
        seed.position.y,
        seed.position.z,
        seed.velocity.x,
        seed.velocity.y,
        seed.velocity.z,
      ],
    );
  }

  private static subtract(
    a: LaunchSeedVector,
    b: LaunchSeedVector,
  ): LaunchSeedVector {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  }

  private static scale(
    vector: LaunchSeedVector,
    factor: number,
  ): LaunchSeedVector {
    return {
      x: vector.x * factor,
      y: vector.y * factor,
      z: vector.z * factor,
    };
  }

  private static finite(vector: LaunchSeedVector): boolean {
    return (
      Number.isFinite(vector.x) &&
      Number.isFinite(vector.y) &&
      Number.isFinite(vector.z)
    );
  }
}
