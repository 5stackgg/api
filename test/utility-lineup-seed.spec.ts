import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  UtilityArtifactsService,
  UtilityTrajectoryInput,
} from "./../src/utility/utility-artifacts.service";
import {
  UtilityLineupsService,
  UtilityServerContext,
} from "./../src/utility/utility-lineups.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { UtilityPendingLineup } from "./../src/utility/utility-load.service";
import { UtilityCalloutsService } from "./../src/utility/utility-callouts.service";

// m_vInitialPosition / m_vInitialVelocity are the engine's own starting state
// for the projectile. Storing them is what makes a lineup replayable exactly
// rather than approximately -- and a zeroed seed is not a missing one, it is a
// grenade launched from the world origin, so nothing here may invent values.
describe("utility lineup physics seed (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let uploads: Array<UtilityTrajectoryInput>;

  const SEED = {
    initial_pos_x: -1911.5,
    initial_pos_y: 921.25,
    initial_pos_z: -102.75,
    initial_vel_x: 415.5,
    initial_vel_y: -320.25,
    initial_vel_z: 590.125,
  };

  beforeAll(async () => {
    db = await bootMigratedDb("UtilitySeedTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199920000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    uploads = [];
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
  });

  function makeService(): UtilityLineupsService {
    return new UtilityLineupsService(
      new Logger("UtilitySeedTest"),
      postgres,
      {
        uploadTrajectory: jest.fn(
          async (input: UtilityTrajectoryInput): Promise<string> => {
            uploads.push(input);
            return "utility/test/trajectory.json.gz";
          },
        ),
        removeTrajectories: jest.fn(async (): Promise<void> => undefined),
      } as unknown as never,
      {
        get: jest.fn(async (_key: string, fallback?: unknown) => fallback),
        put: jest.fn(async (): Promise<boolean> => true),
      } as unknown as never,
      {
        pending: jest.fn(async (): Promise<Array<UtilityPendingLineup>> => []),
      } as unknown as never,
      new UtilityCalloutsService(new Logger("UtilitySeedTest"), postgres),
    );
  }

  async function context(): Promise<{
    ctx: UtilityServerContext;
    author: string;
  }> {
    const author = await fx.player();
    const match = await fx.match();

    return {
      author,
      ctx: {
        serverId: randomUUID(),
        matchId: match.id,
        mapName: "de_mirage",
        lineupSteamIds: [author],
      },
    };
  }

  function payload(author: string, overrides: Record<string, unknown> = {}) {
    return {
      author_steam_id: author,
      utility_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      throw_strength: "Full",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: -560,
      land_y: 320,
      land_z: -140,
      flight_time_ms: 1800,
      name: "Window from T spawn",
      path: [
        { tick: 0, x: -1912, y: 922, z: -100 },
        { tick: 32, x: -1200, y: 600, z: 40 },
        { tick: 64, x: -560, y: 320, z: -140 },
      ],
      ...overrides,
    };
  }

  async function stored(lineupId: string) {
    const [row] = await postgres.query<
      Array<{
        initial_pos_x: number | null;
        initial_pos_y: number | null;
        initial_pos_z: number | null;
        initial_vel_x: number | null;
        initial_vel_y: number | null;
        initial_vel_z: number | null;
        confidence: string;
      }>
    >(
      `SELECT initial_pos_x, initial_pos_y, initial_pos_z,
              initial_vel_x, initial_vel_y, initial_vel_z, confidence
         FROM utility_lineups WHERE id = $1::uuid`,
      [lineupId],
    );
    return row;
  }

  it("round-trips every part of a seeded throw", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    const { id } = await service.ingest(ctx, payload(author, SEED));

    expect(await stored(id)).toEqual({ ...SEED, confidence: "exact" });
  });

  // A null has to keep meaning "cannot be replayed exactly". Zeros would read
  // as a seed at the world origin, which is where the plugin's replay bug
  // launched from.
  it("stores nulls rather than zeros for a throw with no seed", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    const { id } = await service.ingest(ctx, payload(author));

    const row = await stored(id);
    expect(row.initial_pos_x).toBeNull();
    expect(row.initial_pos_y).toBeNull();
    expect(row.initial_pos_z).toBeNull();
    expect(row.initial_vel_x).toBeNull();
    expect(row.initial_vel_y).toBeNull();
    expect(row.initial_vel_z).toBeNull();
    // Still exact: the server watched this grenade fly. The confidence trigger
    // demotes typed-in coordinates, not a measurement that happens to be
    // missing its seed.
    expect(row.confidence).toBe("exact");
  });

  it("refuses half a seed", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    await expect(
      service.ingest(
        ctx,
        payload(author, {
          initial_pos_x: SEED.initial_pos_x,
          initial_pos_y: SEED.initial_pos_y,
          initial_pos_z: SEED.initial_pos_z,
        }),
      ),
    ).rejects.toThrow(/seed is incomplete/);
  });

  it("refuses a velocity faster than the engine allows", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    await expect(
      service.ingest(
        ctx,
        payload(author, {
          ...SEED,
          initial_vel_x: UtilityLineupsService.MAX_VELOCITY + 1,
          initial_vel_y: 0,
          initial_vel_z: 0,
        }),
      ),
    ).rejects.toThrow(/faster than the engine allows/);
  });

  it("refuses a seed position outside the map", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    await expect(
      service.ingest(ctx, payload(author, { ...SEED, initial_pos_x: 999999 })),
    ).rejects.toThrow(/outside the map/);
  });

  it("hands the seed to the trajectory artifact alongside the path", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    await service.ingest(ctx, payload(author, SEED));

    expect(uploads.length).toBe(1);
    expect(uploads[0].initialPosition).toEqual({
      x: SEED.initial_pos_x,
      y: SEED.initial_pos_y,
      z: SEED.initial_pos_z,
    });
    expect(uploads[0].initialVelocity).toEqual({
      x: SEED.initial_vel_x,
      y: SEED.initial_vel_y,
      z: SEED.initial_vel_z,
    });

    const blob = UtilityArtifactsService.buildTrajectoryBlob(uploads[0]);
    expect(blob.grenade_trajectories[0].initial_position).toEqual(
      uploads[0].initialPosition,
    );
    expect(blob.grenade_trajectories[0].initial_velocity).toEqual(
      uploads[0].initialVelocity,
    );
  });

  it("leaves the artifact's seed null when the throw had none", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    await service.ingest(ctx, payload(author));

    const blob = UtilityArtifactsService.buildTrajectoryBlob(uploads[0]);
    expect(blob.grenade_trajectories[0].initial_position).toBeNull();
    expect(blob.grenade_trajectories[0].initial_velocity).toBeNull();
  });

  // The plugin replays a stored lineup off what the library hands it, so the
  // seed has to survive the trip back out.
  it("gives the seed back to the plugin in the library", async () => {
    const { ctx, author } = await context();
    const service = makeService();

    await service.ingest(ctx, payload(author, SEED));

    const [row] = await service.library(ctx, author);

    expect(row.initial_pos_x).toBe(SEED.initial_pos_x);
    expect(row.initial_vel_z).toBe(SEED.initial_vel_z);
  });
});
