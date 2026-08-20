import zlib from "zlib";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  DemoMetadataService,
  PlaybackBlob,
} from "./../src/demos/demo-metadata.service";
import {
  UtilityArtifactsService,
  UtilityTrajectoryInput,
} from "./../src/utility/utility-artifacts.service";
import { UtilityLineupsService } from "./../src/utility/utility-lineups.service";
import { UtilityMiningService } from "./../src/utility/utility-mining.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A lineup mined out of a demo is a reconstruction, not a recording: the
// crosshair, the standing pixel and the release timing are all inferred from
// where the grenade went. These tests pin the inference -- that it recovers the
// aim it was given, that it refuses to name a release it cannot identify, and
// that it never fills the physics seed a demo does not carry.
describe("utility lineups mined from demos (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let uploads: Array<UtilityTrajectoryInput>;

  const TICK_RATE = 64;
  // CS2 scales a projectile's gravity down from Source's 800, which is what a
  // fitted trajectory comes back with.
  const GRENADE_GRAVITY = 320;
  const FULL_THROW_SPEED = 750;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityMiningTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199930000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    uploads = [];
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM players");
  });

  type Vector = { x: number; y: number; z: number };

  type ThrowSpec = {
    gid?: number;
    type?: string;
    team?: string;
    thrower?: string;
    throwTick?: number;
    yaw?: number;
    pitch?: number;
    speed?: number;
    origin?: Vector;
    land?: Vector;
    playerVelocity?: Vector;
    ducked?: boolean;
    detonated?: boolean;
    trajectoryPoints?: number;
    positions?: boolean;
    // Ticks between position samples. 1 is the full-rate burst the parser now
    // emits around a throw; 16 is the 4Hz baseline a pre-burst blob carries.
    sampleEvery?: number;
    recordedYaw?: number;
    recordedPitch?: number;
    smokeVolume?: Record<string, unknown>;
  };

  // Source's forward vector: yaw around z, pitch counted positive downwards.
  function forward(yaw: number, pitch: number): Vector {
    const y = (yaw * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    return {
      x: Math.cos(y) * Math.cos(p),
      y: Math.sin(y) * Math.cos(p),
      z: -Math.sin(p),
    };
  }

  // A demo blob carrying one grenade thrown exactly as specified: the
  // trajectory is the real parabola the engine would produce, and the position
  // rows are the full-rate burst the parser emits around a throw.
  function blobWith(...specs: Array<ThrowSpec>): PlaybackBlob {
    const grenades: Array<unknown> = [];
    const trajectories: Array<unknown> = [];
    const positions: Array<unknown> = [];
    const volumes: Array<unknown> = [];

    for (const raw of specs) {
      const spec: Required<
        Omit<ThrowSpec, "smokeVolume" | "recordedYaw" | "recordedPitch">
      > & {
        smokeVolume?: Record<string, unknown>;
        recordedYaw?: number;
        recordedPitch?: number;
      } = {
        gid: 7,
        type: "Smoke",
        team: "t",
        thrower: "76561198000000001",
        throwTick: 1000,
        yaw: 133.7,
        pitch: -12.4,
        speed: FULL_THROW_SPEED,
        origin: { x: -1912, y: 922, z: -167 },
        land: { x: -560, y: 320, z: -140 },
        playerVelocity: { x: 0, y: 0, z: 0 },
        ducked: false,
        detonated: true,
        trajectoryPoints: 4,
        positions: true,
        sampleEvery: 1,
        ...raw,
      };

      const aim = forward(spec.yaw, spec.pitch);
      const release = {
        x: aim.x * spec.speed + spec.playerVelocity.x,
        y: aim.y * spec.speed + spec.playerVelocity.y,
        z: aim.z * spec.speed + spec.playerVelocity.z,
      };
      // The projectile spawns at eye level, not at the player's feet.
      const spawn = {
        x: spec.origin.x,
        y: spec.origin.y,
        z: spec.origin.z + 64,
      };

      grenades.push({
        round: 3,
        tick: spec.throwTick,
        grenade_id: spec.gid,
        thrower_steam_id: spec.thrower,
        thrower_team: spec.team,
        type: spec.type,
        phase: "thrown",
        ...spawn,
      });

      if (spec.detonated) {
        grenades.push({
          round: 3,
          tick: spec.throwTick + 96,
          grenade_id: spec.gid,
          thrower_steam_id: spec.thrower,
          thrower_team: spec.team,
          type: spec.type,
          phase: "detonated",
          ...spec.land,
        });
      }

      const pts: Array<{ t: number; x: number; y: number; z: number }> = [];
      for (let index = 0; index < spec.trajectoryPoints; index++) {
        const ticks = index * 2;
        const seconds = ticks / TICK_RATE;
        pts.push({
          t: spec.throwTick + ticks,
          x: spawn.x + release.x * seconds,
          y: spawn.y + release.y * seconds,
          z:
            spawn.z +
            release.z * seconds -
            0.5 * GRENADE_GRAVITY * seconds * seconds,
        });
      }
      trajectories.push({ gid: spec.gid, pts });

      if (spec.positions) {
        for (let step = -2; step <= 2; step++) {
          const offset = step * spec.sampleEvery;
          const seconds = offset / TICK_RATE;
          positions.push({
            round: 3,
            tick: spec.throwTick + offset,
            attacker_steam_id: spec.thrower,
            attacker_team: spec.team,
            alive: true,
            x: spec.origin.x + spec.playerVelocity.x * seconds,
            y: spec.origin.y + spec.playerVelocity.y * seconds,
            z: spec.origin.z + spec.playerVelocity.z * seconds,
            yaw: spec.recordedYaw ?? spec.yaw,
            pitch: spec.recordedPitch ?? spec.pitch,
            health: 100,
            armor: 100,
            helmet: true,
            has_bomb: false,
            has_defuser: false,
            active_weapon: "smokegrenade",
            ducked: spec.ducked,
          });
        }
      }

      if (spec.smokeVolume) {
        volumes.push({ gid: spec.gid, ...spec.smokeVolume });
      }
    }

    return {
      schema_version: 10,
      parser_schema_version: 2,
      match_map_id: randomUUID(),
      tick_rate: TICK_RATE,
      total_ticks: 100000,
      map_name: "de_mirage",
      round_ticks: [],
      players: [],
      kills: [],
      bombs: [],
      kit_drops: [],
      positions,
      shots_fired: [],
      grenade_throws: grenades,
      grenade_trajectories: trajectories,
      smoke_volumes: volumes,
      infernos: [],
      damages: [],
      round_inventory: [],
    } as unknown as PlaybackBlob;
  }

  type MatchQuery = {
    matches: Array<{
      id: string;
      match_maps: Array<{ id: string; map: { name: string } }>;
    }>;
  };

  type HasuraQueryMock = jest.Mock<
    Promise<MatchQuery>,
    [unknown, (string | undefined)?]
  >;

  function artifactsStub() {
    return {
      uploadTrajectory: jest.fn(
        async (input: UtilityTrajectoryInput): Promise<string> => {
          uploads.push(input);
          return "utility/test/trajectory.json.gz";
        },
      ),
      removeTrajectories: jest.fn(async (): Promise<void> => undefined),
    } as unknown as UtilityArtifactsService;
  }

  function cacheStub() {
    const store = new Map<string, unknown>();
    return {
      store,
      service: {
        get: jest.fn(async (key: string, fallback?: unknown) =>
          store.has(key) ? store.get(key) : fallback,
        ),
        put: jest.fn(async (key: string, value: unknown): Promise<boolean> => {
          store.set(key, value);
          return true;
        }),
        forget: jest.fn(async (key: string): Promise<boolean> => {
          store.delete(key);
          return true;
        }),
      },
    };
  }

  function lineupsService(artifacts: UtilityArtifactsService) {
    return new UtilityLineupsService(
      new Logger("UtilityMiningTest"),
      postgres,
      artifacts,
      cacheStub().service as never,
    );
  }

  async function demoContext() {
    const author = await fx.player();
    const ctx = await fx.bareMatch();
    const [row] = await postgres.query<Array<{ name: string }>>(
      `SELECT mp.name FROM match_maps mm
         INNER JOIN maps mp ON mp.id = mm.map_id
        WHERE mm.id = $1::uuid`,
      [ctx.mapId],
    );
    return { author, ...ctx, mapName: row.name };
  }

  function miningService(
    context: { matchId: string; mapId: string; mapName: string },
    blob: PlaybackBlob,
    overrides: {
      artifacts?: UtilityArtifactsService;
      readPlaybackBlob?: jest.Mock<Promise<PlaybackBlob>, []>;
      hasuraQuery?: HasuraQueryMock;
    } = {},
  ) {
    const artifacts = overrides.artifacts ?? artifactsStub();
    const hasura = {
      query:
        overrides.hasuraQuery ??
        (jest.fn(
          async (): Promise<MatchQuery> => ({
            matches: [
              {
                id: context.matchId,
                match_maps: [
                  { id: context.mapId, map: { name: context.mapName } },
                ],
              },
            ],
          }),
        ) as unknown as HasuraQueryMock),
    };

    return new UtilityMiningService(
      new Logger("UtilityMiningTest"),
      postgres,
      hasura as never,
      {
        readPlaybackBlob:
          overrides.readPlaybackBlob ??
          jest.fn(async (): Promise<PlaybackBlob> => blob),
      } as never,
      artifacts,
      lineupsService(artifacts),
    );
  }

  async function seedDemoRow(context: { matchId: string; mapId: string }) {
    await postgres.query(
      `INSERT INTO match_map_demos (match_id, match_map_id, file, playback_file)
       VALUES ($1::uuid, $2::uuid, 'test.dem', 'demos/x/playback.v10.1.json.gz')`,
      [context.matchId, context.mapId],
    );
  }

  describe("recovering the throw from the flight", () => {
    it("derives the release aim from the trajectory to within a couple of degrees", () => {
      const mined = UtilityMiningService.mine(
        blobWith({ yaw: 133.7, pitch: -12.4 }),
        7,
        "de_mirage",
      );

      expect(mined.viewYaw).toBeCloseTo(133.7, 0);
      expect(mined.viewPitch).toBeCloseTo(-12.4, 0);
      expect(Math.abs(mined.viewYaw - 133.7)).toBeLessThan(1.5);
      expect(Math.abs(mined.viewPitch - -12.4)).toBeLessThan(1.5);
    });

    it("derives it through a run, where the release velocity is not the aim", () => {
      const blob = blobWith({
        yaw: 90,
        pitch: -20,
        playerVelocity: { x: 215, y: 0, z: 0 },
      });

      const mined = UtilityMiningService.mine(blob, 7, "de_mirage");

      expect(Math.abs(mined.viewYaw - 90)).toBeLessThan(2);
      expect(Math.abs(mined.viewPitch - -20)).toBeLessThan(2);

      // The correction is not cosmetic: reading the raw release velocity as the
      // aim would put the crosshair somewhere else entirely.
      const aim = forward(90, -20);
      const naiveYaw =
        (Math.atan2(aim.y * FULL_THROW_SPEED, aim.x * FULL_THROW_SPEED + 215) *
          180) /
        Math.PI;
      expect(Math.abs(naiveYaw - 90)).toBeGreaterThan(5);
    });

    it("records the disagreement with the demo's own view angles instead of picking a winner", () => {
      const agreeing = UtilityMiningService.mine(
        blobWith({ yaw: 40, pitch: -8 }),
        7,
        "de_mirage",
      );
      expect(Math.abs(agreeing.viewYawDelta ?? 99)).toBeLessThan(1.5);

      const disagreeing = UtilityMiningService.mine(
        blobWith({ yaw: 40, pitch: -8, recordedYaw: 55 }),
        7,
        "de_mirage",
      );
      expect(disagreeing.viewYaw).toBeCloseTo(40, 0);
      expect(disagreeing.viewYawDelta ?? 0).toBeLessThan(-13);
      expect(disagreeing.viewYawDelta ?? 0).toBeGreaterThan(-17);
    });

    it("measures the yaw disagreement the short way round the circle", () => {
      const mined = UtilityMiningService.mine(
        blobWith({ yaw: 179, recordedYaw: -179 }),
        7,
        "de_mirage",
      );

      expect(Math.abs(mined.viewYawDelta ?? 0)).toBeLessThan(4);
    });

    it("refuses a grenade the demo barely sampled", () => {
      expect(() =>
        UtilityMiningService.mine(
          blobWith({ trajectoryPoints: 2 }),
          7,
          "de_mirage",
        ),
      ).toThrow(/did not sample enough/);
    });

    it("refuses a grenade that never landed", () => {
      expect(() =>
        UtilityMiningService.mine(blobWith({ detonated: false }), 7, "de_mirage"),
      ).toThrow(/never landed/);
    });
  });

  describe("where the throw is set up from", () => {
    // A jump throw releases at the apex, so the release tick answers "where was
    // the grenade born" and never "where do I stand to do this". The origin has
    // to come from the standstill before the jump.
    function jumpThrow(groundZ: number, apexZ: number): PlaybackBlob {
      const blob = blobWith({ throwTick: 1000, origin: { x: -1912, y: 922, z: apexZ } });

      const rows: Array<Record<string, unknown>> = [];

      // Eight ticks standing still on the floor, then a jump peaking exactly at
      // the release tick.
      for (let tick = 984; tick <= 1000; tick++) {
        const airborne = tick > 992;
        const climb = airborne ? ((tick - 992) / 8) * (apexZ - groundZ) : 0;

        rows.push({
          round: 3,
          tick,
          attacker_steam_id: "76561198000000001",
          attacker_team: "t",
          alive: true,
          x: -1912,
          y: 922,
          z: groundZ + climb,
          yaw: 133.7,
          pitch: -12.4,
          health: 100,
          armor: 100,
        });
      }

      (blob as unknown as { positions: unknown }).positions = rows;

      return blob;
    }

    it("takes the origin from the standstill, not the apex of the jump", () => {
      const mined = UtilityMiningService.mine(jumpThrow(-167, -113), 7, "de_mirage");

      expect(mined.origin.z).toBeCloseTo(-167, 0);
    });

    it("measures eye height from that standstill", () => {
      const mined = UtilityMiningService.mine(jumpThrow(-167, -113), 7, "de_mirage");

      expect(mined.eyeZ).toBeCloseTo(-167 + 64, 0);
    });

    it("leaves a standing throw exactly where it was thrown", () => {
      const mined = UtilityMiningService.mine(
        blobWith({ origin: { x: -1912, y: 922, z: -167 } }),
        7,
        "de_mirage",
      );

      expect(mined.origin.z).toBeCloseTo(-167, 0);
      expect(mined.origin.x).toBeCloseTo(-1912, 0);
    });
  });

  describe("classifying the throw", () => {
    it("buckets a full, a half and a drop, and names nothing in between", () => {
      expect(UtilityMiningService.strengthOf(750)).toBe("Full");
      expect(UtilityMiningService.strengthOf(660)).toBe("Full");
      expect(UtilityMiningService.strengthOf(420)).toBe("Half");
      expect(UtilityMiningService.strengthOf(320)).toBe("Half");
      expect(UtilityMiningService.strengthOf(150)).toBe("Drop");

      // The gaps are the point: a release between two buckets is one we cannot
      // name, and naming it would make the lineup unreproducible in a way
      // nobody could see.
      expect(UtilityMiningService.strengthOf(620)).toBeNull();
      expect(UtilityMiningService.strengthOf(280)).toBeNull();
    });

    it("buckets the impulse rather than the ground speed it was thrown at", () => {
      const running = UtilityMiningService.mine(
        blobWith({ speed: 750, playerVelocity: { x: 215, y: 0, z: 0 } }),
        7,
        "de_mirage",
      );

      expect(running.throwStrength).toBe("Full");
      expect(running.throwSpeed ?? 0).toBeGreaterThan(730);
      expect(running.throwSpeed ?? 0).toBeLessThan(770);
    });

    it("leaves the strength null when the release falls between buckets", () => {
      const mined = UtilityMiningService.mine(
        blobWith({ speed: 620 }),
        7,
        "de_mirage",
      );

      expect(mined.throwStrength).toBeNull();
    });

    it("reads the crouch flag the parser now carries", () => {
      expect(
        UtilityMiningService.mine(blobWith({ ducked: true }), 7, "de_mirage")
          .technique,
      ).toBe("Crouch");
      expect(
        UtilityMiningService.mine(blobWith({ ducked: false }), 7, "de_mirage")
          .technique,
      ).toBe("Stationary");
    });

    it("tells a run throw and a jump throw apart", () => {
      expect(
        UtilityMiningService.mine(
          blobWith({ playerVelocity: { x: 215, y: 0, z: 0 } }),
          7,
          "de_mirage",
        ).technique,
      ).toBe("Running");

      expect(
        UtilityMiningService.mine(
          blobWith({ playerVelocity: { x: 0, y: 0, z: 260 } }),
          7,
          "de_mirage",
        ).technique,
      ).toBe("Jump");

      expect(
        UtilityMiningService.mine(
          blobWith({ playerVelocity: { x: 215, y: 0, z: 260 } }),
          7,
          "de_mirage",
        ).technique,
      ).toBe("RunJump");
    });

    it("stands the player on their feet, not on the projectile's spawn point", () => {
      const mined = UtilityMiningService.mine(
        blobWith({ origin: { x: -1912, y: 922, z: -167 } }),
        7,
        "de_mirage",
      );

      expect(mined.origin.z).toBeCloseTo(-167, 1);
      expect(mined.eyeZ).toBeCloseTo(-103, 1);
    });
  });

  describe("the HE naming trap", () => {
    it("maps the parser's HE onto the enum's HighExplosive", () => {
      const mined = UtilityMiningService.mine(
        blobWith({ type: "HE" }),
        7,
        "de_mirage",
      );

      expect(mined.utilityType).toBe("HighExplosive");
    });

    it("maps every other type through unchanged", () => {
      for (const type of ["Flash", "Smoke", "Molotov", "Decoy"]) {
        expect(
          UtilityMiningService.mine(blobWith({ type }), 7, "de_mirage").utilityType,
        ).toBe(type);
      }
    });

    it("refuses a type it has no name for rather than dropping the lineup", () => {
      expect(() =>
        UtilityMiningService.mine(blobWith({ type: "Nuke" }), 7, "de_mirage"),
      ).toThrow(/unknown grenade type/);
    });

    it("stores an HE lineup, which the utility-type foreign key would reject unmapped", async () => {
      const context = await demoContext();
      await seedDemoRow(context);
      const service = miningService(
        context,
        blobWith({ type: "HE", thrower: context.author }),
      );

      const { id } = await service.saveFromDemo({
        user: { steam_id: context.author } as never,
        match_id: context.matchId,
        match_map_id: context.mapId,
        grenade_id: 7,
        name: "Window HE",
      });

      const [row] = await postgres.query<Array<{ utility_type: string }>>(
        "SELECT utility_type FROM utility_lineups WHERE id = $1::uuid",
        [id],
      );
      expect(row.utility_type).toBe("HighExplosive");
    });
  });

  describe("writing the lineup", () => {
    it("files it as demo-derived and unverified, with its provenance", async () => {
      const context = await demoContext();
      await seedDemoRow(context);
      const service = miningService(
        context,
        blobWith({ thrower: context.author }),
      );

      const { id } = await service.saveFromDemo({
        user: { steam_id: context.author } as never,
        match_id: context.matchId,
        match_map_id: context.mapId,
        grenade_id: 7,
        name: "A site smoke",
      });

      const [row] = await postgres.query<
        Array<{
          origin_source: string;
          confidence: string;
          verified_at: Date | null;
          source_match_id: string;
          source_match_map_id: string;
          source_grenade_id: number;
          jump_throw_bind: boolean;
          view_yaw_delta: number | null;
        }>
      >(
        `SELECT origin_source, confidence, verified_at,
                source_match_id::text AS source_match_id,
                source_match_map_id::text AS source_match_map_id,
                source_grenade_id, jump_throw_bind, view_yaw_delta
           FROM utility_lineups WHERE id = $1::uuid`,
        [id],
      );

      expect(row.origin_source).toBe("demo");
      expect(row.confidence).toBe("derived");
      expect(row.verified_at).toBeNull();
      expect(row.source_match_id).toBe(context.matchId);
      expect(row.source_match_map_id).toBe(context.mapId);
      expect(row.source_grenade_id).toBe(7);
      // Nothing in a demo says whether the jump was bound or hand timed.
      expect(row.jump_throw_bind).toBe(false);
      expect(row.view_yaw_delta).not.toBeNull();
    });

    it("leaves the physics seed null, because a demo does not carry one", async () => {
      const context = await demoContext();
      await seedDemoRow(context);
      const service = miningService(
        context,
        blobWith({ thrower: context.author }),
      );

      const { id } = await service.saveFromDemo({
        user: { steam_id: context.author } as never,
        match_id: context.matchId,
        match_map_id: context.mapId,
        grenade_id: 7,
        name: "A site smoke",
      });

      const [row] = await postgres.query<
        Array<{
          initial_pos_x: number | null;
          initial_pos_y: number | null;
          initial_pos_z: number | null;
          initial_vel_x: number | null;
          initial_vel_y: number | null;
          initial_vel_z: number | null;
        }>
      >(
        `SELECT initial_pos_x, initial_pos_y, initial_pos_z,
                initial_vel_x, initial_vel_y, initial_vel_z
           FROM utility_lineups WHERE id = $1::uuid`,
        [id],
      );

      for (const value of Object.values(row)) {
        expect(value).toBeNull();
      }

      // And the artifact must not invent one either -- a zeroed seed fires the
      // replay's ghost from the world origin.
      expect(uploads[0].initialPosition).toBeNull();
      expect(uploads[0].initialVelocity).toBeNull();
    });

    it("hands the demo's own measured smoke volume to the artifact", async () => {
      const context = await demoContext();
      await seedDemoRow(context);
      const service = miningService(
        context,
        blobWith({
          thrower: context.author,
          smokeVolume: {
            start_tick: 1096,
            ox: -600,
            oy: 280,
            oz: -160,
            vs: 16,
            dx: 19,
            dy: 19,
            dz: 12,
            den: "AAAA",
          },
        }),
      );

      await service.saveFromDemo({
        user: { steam_id: context.author } as never,
        match_id: context.matchId,
        match_map_id: context.mapId,
        grenade_id: 7,
        name: "A site smoke",
      });

      expect(uploads[0].smokeVolume?.dx).toBe(19);
    });

    it("refuses to mine a match Hasura will not show the caller", async () => {
      const context = await demoContext();
      await seedDemoRow(context);
      const service = miningService(
        context,
        blobWith({ thrower: context.author }),
        {
          hasuraQuery: jest.fn(
            async (): Promise<MatchQuery> => ({ matches: [] }),
          ) as unknown as HasuraQueryMock,
        },
      );

      await expect(
        service.saveFromDemo({
          user: { steam_id: context.author } as never,
          match_id: context.matchId,
          match_map_id: context.mapId,
          grenade_id: 7,
          name: "A site smoke",
        }),
      ).rejects.toThrow(/match not found/);

      const [row] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM utility_lineups",
      );
      expect(Number(row.count)).toBe(0);
    });

    it("asks Hasura as the caller, never as the admin", async () => {
      const context = await demoContext();
      await seedDemoRow(context);
      const hasuraQuery: HasuraQueryMock = jest.fn(
        async (): Promise<MatchQuery> => ({
          matches: [
            {
              id: context.matchId,
              match_maps: [
                { id: context.mapId, map: { name: context.mapName } },
              ],
            },
          ],
        }),
      ) as unknown as HasuraQueryMock;
      const service = miningService(
        context,
        blobWith({ thrower: context.author }),
        { hasuraQuery },
      );

      await service.saveFromDemo({
        user: { steam_id: context.author } as never,
        match_id: context.matchId,
        match_map_id: context.mapId,
        grenade_id: 7,
        name: "A site smoke",
      });

      expect(hasuraQuery.mock.calls[0][1]).toBe(context.author);
    });
  });

  describe("reading the playback blob", () => {
    function metadataService(payload: unknown) {
      const cache = cacheStub();
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
      const get = jest.fn(async () => Readable.from([gz]));

      const service = new DemoMetadataService(
        new Logger("UtilityMiningTest"),
        null as never,
        postgres,
        { get } as never,
        null as never,
        null as never,
        cache.service as never,
      );

      return { service, get, cache };
    }

    it("inflates one blob once, however many lineups are saved off it", async () => {
      const { service, get } = metadataService(blobWith());

      await service.readPlaybackBlob("demos/a/playback.v10.1.json.gz");
      await service.readPlaybackBlob("demos/a/playback.v10.1.json.gz");
      await service.readPlaybackBlob("demos/a/playback.v10.1.json.gz");

      expect(get).toHaveBeenCalledTimes(1);
    });

    it("collapses three simultaneous reads of one blob into one inflate", async () => {
      const { service, get } = metadataService(blobWith());

      const [one, two, three] = await Promise.all([
        service.readPlaybackBlob("demos/b/playback.v10.1.json.gz"),
        service.readPlaybackBlob("demos/b/playback.v10.1.json.gz"),
        service.readPlaybackBlob("demos/b/playback.v10.1.json.gz"),
      ]);

      expect(get).toHaveBeenCalledTimes(1);
      expect(one.map_name).toBe("de_mirage");
      expect(two.map_name).toBe("de_mirage");
      expect(three.map_name).toBe("de_mirage");
    });

    it("memoises under the playback key so a second demo is not confused for the first", async () => {
      const { service, get, cache } = metadataService(blobWith());

      await service.readPlaybackBlob("demos/c/playback.v10.1.json.gz");
      await service.readPlaybackBlob("demos/d/playback.v10.1.json.gz");

      expect(get).toHaveBeenCalledTimes(2);
      expect([...cache.store.keys()]).toEqual([
        "playback-blob:demos/c/playback.v10.1.json.gz",
        "playback-blob:demos/d/playback.v10.1.json.gz",
      ]);
    });
  });

  describe("the smoke bloom artifact", () => {
    type SmokeVolumeMock = jest.Mock<
      Promise<Record<string, unknown> | null>,
      [string, { x: number; y: number; z: number }]
    >;

    function artifactsWith(smokeVolume: SmokeVolumeMock) {
      const puts: Array<Buffer> = [];
      const service = new UtilityArtifactsService(
        new Logger("UtilityMiningTest"),
        {
          put: jest.fn(async (_key: string, body: Buffer): Promise<void> => {
            puts.push(body);
          }),
          remove: jest.fn(async (): Promise<void> => undefined),
        } as never,
        postgres,
        { smokeVolume } as never,
      );
      return { service, puts };
    }

    const input = (utilityType: string): UtilityTrajectoryInput => ({
      lineupId: randomUUID(),
      mapName: "de_mirage",
      utilityType,
      throwerSteamId: null,
      throwerTeam: "TERRORIST",
      origin: { x: 0, y: 0, z: 0 },
      land: { x: -560, y: 320, z: -140 },
      initialPosition: null,
      initialVelocity: null,
      flightTimeMs: 1500,
      tickRate: TICK_RATE,
      path: [
        { tick: 0, x: 0, y: 0, z: 0 },
        { tick: 96, x: -560, y: 320, z: -140 },
      ],
    });

    const blobOf = (buffer: Buffer) =>
      JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));

    it("embeds the measured bloom for a smoke lineup that never came from a demo", async () => {
      const smokeVolume = jest.fn(
        async (): Promise<Record<string, unknown>> => ({
          ox: -600,
          oy: 280,
          oz: -160,
          vs: 16,
          dx: 19,
          dy: 19,
          dz: 12,
          den: "AAAA",
          cells: 900,
          radius: 144,
        }),
      ) as unknown as SmokeVolumeMock;
      const { service, puts } = artifactsWith(smokeVolume);

      await service.uploadTrajectory(input("Smoke"));

      expect(smokeVolume).toHaveBeenCalledWith("de_mirage", {
        x: -560,
        y: 320,
        z: -140,
      });
      expect(blobOf(puts[0]).smoke_volumes[0].dx).toBe(19);
      expect(blobOf(puts[0]).smoke_volumes[0].gid).toBe(1);
    });

    it("saves the lineup anyway when the parser is unreachable", async () => {
      const smokeVolume = jest.fn(
        async (): Promise<Record<string, unknown> | null> => {
          throw new Error("demo-parser unreachable: ECONNREFUSED");
        },
      ) as unknown as SmokeVolumeMock;
      const { service, puts } = artifactsWith(smokeVolume);

      const key = await service.uploadTrajectory(input("Smoke"));

      expect(key).toContain("trajectory.v3.");
      expect(blobOf(puts[0]).smoke_volumes).toEqual([]);
    });

    it("saves the lineup anyway when the map has no mesh", async () => {
      const smokeVolume = jest.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ) as unknown as SmokeVolumeMock;
      const { service, puts } = artifactsWith(smokeVolume);

      await service.uploadTrajectory(input("Smoke"));

      expect(blobOf(puts[0]).smoke_volumes).toEqual([]);
    });

    it("does not go looking for a bloom a flash cannot have", async () => {
      const smokeVolume = jest.fn(
        async (): Promise<Record<string, unknown> | null> => null,
      ) as unknown as SmokeVolumeMock;
      const { service } = artifactsWith(smokeVolume);

      await service.uploadTrajectory(input("Flash"));

      expect(smokeVolume).not.toHaveBeenCalled();
    });
  });
  // "You threw 12 utility; 4 matched known lineups; 3 landed correctly."
  //
  // The whole report is derived on read from rows that already exist, so what
  // these pin is the two ways it can be wrong: reporting zeroes for a demo
  // nobody has mined (which reads as "you threw nothing"), and counting a
  // lineup against a caller who cannot see it.
  describe("post-match utility report", () => {
    const THROW = {
      map_name: "de_mirage",
      utility_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      land_x: -560,
      land_y: 320,
      land_z: -140,
    };

    async function seedDemo(context: {
      matchId: string;
      mapId: string;
    }): Promise<string> {
      const [demo] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_map_demos (match_id, match_map_id, file, playback_file)
         VALUES ($1::uuid, $2::uuid, 'test.dem', 'demos/x/playback.v10.1.json.gz')
         RETURNING id::text AS id`,
        [context.matchId, context.mapId],
      );
      return demo.id;
    }

    async function markMined(
      demoId: string,
      failedReason: string | null = null,
    ) {
      await postgres.query(
        `INSERT INTO utility_demo_mines (match_map_demo_id, version, throws, failed_reason)
         VALUES ($1::uuid, 1, 1, $2)`,
        [demoId, failedReason],
      );
    }

    async function insertThrow(
      demoId: string,
      context: { matchId: string; mapId: string },
      grenadeId: number,
      thrower: string,
      overrides: Record<string, unknown> = {},
    ) {
      const row = {
        match_map_demo_id: demoId,
        grenade_id: grenadeId,
        match_id: context.matchId,
        match_map_id: context.mapId,
        thrower_steam_id: thrower,
        ...THROW,
        ...overrides,
      };
      const cols = Object.keys(row);
      await postgres.query(
        `INSERT INTO utility_demo_throws (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(row),
      );
    }

    async function insertLineup(
      author: string,
      overrides: Record<string, unknown> = {},
    ): Promise<string> {
      const row = {
        ...THROW,
        view_yaw: 133.7,
        view_pitch: -12.4,
        name: "Window",
        visibility: "Public",
        author_steam_id: author,
        ...overrides,
      };
      const cols = Object.keys(row);
      const [inserted] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_lineups (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        Object.values(row),
      );
      return inserted.id;
    }

    const report = async (
      context: { matchId: string; mapId: string; mapName: string },
      steamId: string,
      overrides: { hasuraQuery?: HasuraQueryMock } = {},
    ) =>
      await miningService(context, blobWith({}), overrides).utilityReport(
        { steam_id: steamId, role: "user" } as never,
        { match_id: context.matchId },
      );

    it("says the demo has not been mined rather than reporting zeroes", async () => {
      const context = await demoContext();
      await seedDemo(context);

      const answer = await report(context, context.author);

      expect(answer.analysed).toBe(false);
      expect(answer.message).toBe("this match's demo has not been mined yet");
      expect(answer.throws).toBe(0);
    });

    it("says so when there is no demo at all", async () => {
      const context = await demoContext();

      const answer = await report(context, context.author);

      expect(answer.analysed).toBe(false);
      expect(answer.message).toBe("this match has no demo to analyse");
    });

    // A demo the miner choked on is not a demo that has been read.
    it("does not count a failed mine as analysed", async () => {
      const context = await demoContext();
      const demo = await seedDemo(context);
      await markMined(demo, "playback blob is gone");

      const answer = await report(context, context.author);

      expect(answer.analysed).toBe(false);
    });

    it("counts throws, the lineups they match and where they landed", async () => {
      const context = await demoContext();
      const demo = await seedDemo(context);
      await markMined(demo);

      // Two throws in the saved lineup's bucket: one on the spot, one that
      // stopped on a ledge 200 units above it. The bucket only quantizes x and
      // y, so sharing a cell is not the same as landing in the right place --
      // which is the whole reason the radius is measured rather than assumed.
      await insertThrow(demo, context, 1, context.author);
      await insertThrow(demo, context, 2, context.author, {
        land_x: -520,
        land_y: 360,
        land_z: 60,
      });
      // A different bucket entirely, and a flash nobody has written up.
      await insertThrow(demo, context, 3, context.author, {
        utility_type: "Flash",
        land_x: 900,
        land_y: 900,
      });
      // Somebody else's throw.
      await insertThrow(demo, context, 4, await fx.player());

      await insertLineup(context.author);

      const answer = await report(context, context.author);

      expect(answer.analysed).toBe(true);
      expect(answer.message).toBeNull();
      expect(answer.throws).toBe(3);
      expect(answer.matched_lineups).toBe(2);
      expect(answer.landed).toBe(1);
      expect(answer.radius).toBe(UtilityLineupsService.DEFAULT_SUCCESS_RADIUS);
      expect(answer.by_type).toEqual([
        {
          utility_type: "Flash",
          throws: 1,
          matched_lineups: 0,
          matched_meta: 0,
          landed: 0,
        },
        {
          utility_type: "Smoke",
          throws: 2,
          matched_lineups: 2,
          matched_meta: 0,
          landed: 1,
        },
      ]);
    });

    it("counts a mined meta cluster even with nothing written up", async () => {
      const context = await demoContext();
      const demo = await seedDemo(context);
      await markMined(demo);
      await insertThrow(demo, context, 1, context.author);

      const [{ lineup_bucket }] = await postgres.query<
        Array<{ lineup_bucket: string }>
      >("SELECT lineup_bucket FROM utility_demo_throws LIMIT 1");

      await postgres.query(
        `INSERT INTO utility_meta_lineups
           (lineup_bucket, map_name, utility_type, side, technique,
            origin_x, origin_y, origin_z, land_x, land_y, land_z)
         VALUES ($1, 'de_mirage', 'Smoke', 'TERRORIST', 'Jump', 0, 0, 0, 0, 0, 0)`,
        [lineup_bucket],
      );

      const answer = await report(context, context.author);

      expect(answer.matched_meta).toBe(1);
      expect(answer.matched_lineups).toBe(0);
    });

    // The counts are cut by what the caller can see, so a private lineup can
    // never be inferred from somebody else's report.
    it("does not match a lineup the caller cannot see", async () => {
      const context = await demoContext();
      const demo = await seedDemo(context);
      await markMined(demo);
      await insertThrow(demo, context, 1, context.author);

      await insertLineup(await fx.player(), { visibility: "Private" });

      const answer = await report(context, context.author);

      expect(answer.throws).toBe(1);
      expect(answer.matched_lineups).toBe(0);
      expect(answer.landed).toBe(0);
    });

    it("refuses a match the caller cannot see", async () => {
      const context = await demoContext();
      const demo = await seedDemo(context);
      await markMined(demo);

      await expect(
        report(context, context.author, {
          hasuraQuery: jest.fn(
            async (): Promise<MatchQuery> => ({ matches: [] }),
          ) as unknown as HasuraQueryMock,
        }),
      ).rejects.toThrow("match not found");
    });
  });
});
