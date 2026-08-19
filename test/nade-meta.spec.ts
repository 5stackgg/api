import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { PlaybackBlob } from "./../src/demos/demo-metadata.service";
import { NadeMetaService } from "./../src/nades/nade-meta.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The meta pass answers "what do people actually throw here", which is a
// counting question: the same lineup thrown by twelve players has to read as
// twelve people rather than twelve throws or one.
describe("nade meta clustering (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const TICK_RATE = 64;
  const GRENADE_GRAVITY = 320;

  beforeAll(async () => {
    db = await bootMigratedDb("NadeMetaTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199940000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM nade_meta_lineups");
    await postgres.query("DELETE FROM nade_lineups");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM players");
  });

  type Vector = { x: number; y: number; z: number };

  type Throw = {
    gid: number;
    thrower: string;
    origin: Vector;
    land: Vector;
    type?: string;
    yaw?: number;
    pitch?: number;
    speed?: number;
    detonated?: boolean;
  };

  function blobOf(mapName: string, throws: Array<Throw>): PlaybackBlob {
    const grenades: Array<unknown> = [];
    const trajectories: Array<unknown> = [];
    const positions: Array<unknown> = [];

    for (const spec of throws) {
      const yaw = ((spec.yaw ?? 45) * Math.PI) / 180;
      const pitch = ((spec.pitch ?? -15) * Math.PI) / 180;
      const speed = spec.speed ?? 750;
      const release = {
        x: Math.cos(yaw) * Math.cos(pitch) * speed,
        y: Math.sin(yaw) * Math.cos(pitch) * speed,
        z: -Math.sin(pitch) * speed,
      };
      const tick = 1000 + spec.gid * 200;
      const spawn = {
        x: spec.origin.x,
        y: spec.origin.y,
        z: spec.origin.z + 64,
      };

      grenades.push({
        round: 1,
        tick,
        grenade_id: spec.gid,
        thrower_steam_id: spec.thrower,
        thrower_team: "t",
        type: spec.type ?? "Smoke",
        phase: "thrown",
        ...spawn,
      });

      if (spec.detonated !== false) {
        grenades.push({
          round: 1,
          tick: tick + 96,
          grenade_id: spec.gid,
          thrower_steam_id: spec.thrower,
          thrower_team: "t",
          type: spec.type ?? "Smoke",
          phase: "detonated",
          ...spec.land,
        });
      }

      const pts = [0, 2, 4, 6].map((ticks) => {
        const seconds = ticks / TICK_RATE;
        return {
          t: tick + ticks,
          x: spawn.x + release.x * seconds,
          y: spawn.y + release.y * seconds,
          z:
            spawn.z +
            release.z * seconds -
            0.5 * GRENADE_GRAVITY * seconds * seconds,
        };
      });
      trajectories.push({ gid: spec.gid, pts });

      for (let offset = -2; offset <= 2; offset++) {
        positions.push({
          round: 1,
          tick: tick + offset,
          attacker_steam_id: spec.thrower,
          attacker_team: "t",
          alive: true,
          ...spec.origin,
          yaw: spec.yaw ?? 45,
          pitch: spec.pitch ?? -15,
          ducked: false,
        });
      }
    }

    return {
      schema_version: 10,
      parser_schema_version: 2,
      match_map_id: randomUUID(),
      tick_rate: TICK_RATE,
      total_ticks: 100000,
      map_name: mapName,
      round_ticks: [],
      players: [],
      kills: [],
      bombs: [],
      kit_drops: [],
      positions,
      shots_fired: [],
      grenade_throws: grenades,
      grenade_trajectories: trajectories,
      smoke_volumes: [],
      infernos: [],
      damages: [],
      round_inventory: [],
    } as unknown as PlaybackBlob;
  }

  async function demoFor(mapName?: string) {
    const ctx = await fx.bareMatch();
    const [row] = await postgres.query<Array<{ id: string; name: string }>>(
      `INSERT INTO match_map_demos (match_id, match_map_id, file, playback_file)
       VALUES ($1::uuid, $2::uuid, 'test.dem', $3)
       RETURNING id::text AS id,
                 (SELECT mp.name FROM match_maps mm
                    INNER JOIN maps mp ON mp.id = mm.map_id
                   WHERE mm.id = $2::uuid) AS name`,
      [ctx.matchId, ctx.mapId, `demos/${ctx.matchId}/playback.v10.1.json.gz`],
    );
    return { ...ctx, demoId: row.id, mapName: mapName ?? row.name };
  }

  // Wires the miner to a blob store keyed by every demo currently in the
  // database, so a test only has to say what the demo contained.
  async function metaFor(blob: PlaybackBlob | null): Promise<NadeMetaService> {
    const demos = await postgres.query<Array<{ playback_file: string }>>(
      "SELECT playback_file FROM match_map_demos",
    );
    const blobs = new Map<string, PlaybackBlob>();

    for (const demo of demos) {
      if (blob) {
        blobs.set(demo.playback_file, blob);
      }
    }

    return new NadeMetaService(
      new Logger("NadeMetaTest"),
      postgres,
      {
        readPlaybackBlob: jest.fn(
          async (playbackFile: string): Promise<PlaybackBlob> => {
            const found = blobs.get(playbackFile);
            if (!found) {
              throw new Error("blob is gone");
            }
            return found;
          },
        ),
      } as never,
      { isLibraryEnabled: async (): Promise<boolean> => true } as never,
    );
  }

  const clusters = async () =>
    postgres.query<
      Array<{
        lineup_bucket: string;
        map_name: string;
        nade_type: string;
        technique: string;
        throws: number;
        throwers: number;
        matches: number;
        lineups: number;
        origin_x: number;
        land_x: number;
      }>
    >(
      `SELECT lineup_bucket, map_name, nade_type, technique, throws, throwers,
              matches, lineups, origin_x, land_x
         FROM nade_meta_lineups
        ORDER BY throwers DESC, lineup_bucket`,
    );

  it("counts people, not throws, for a lineup several players run", async () => {
    const demo = await demoFor();
    const [one, two, three] = await fx.players(3);

    const spot = { x: -1912, y: 922, z: -167 };
    const target = { x: -560, y: 320, z: -140 };

    const blob = blobOf(demo.mapName, [
      { gid: 1, thrower: one, origin: spot, land: target },
      // Same player again: the same spot twice is one person, two throws.
      { gid: 2, thrower: one, origin: spot, land: target },
      // A few units off, still inside the same 64-unit bucket.
      {
        gid: 3,
        thrower: two,
        origin: { ...spot, x: spot.x + 20 },
        land: { ...target, y: target.y + 15 },
      },
      { gid: 4, thrower: three, origin: spot, land: target },
    ]);

    await (await metaFor(blob)).mine();

    const rows = await clusters();

    expect(rows.length).toBe(1);
    expect(Number(rows[0].throws)).toBe(4);
    expect(Number(rows[0].throwers)).toBe(3);
    expect(Number(rows[0].matches)).toBe(1);
    expect(rows[0].map_name).toBe(demo.mapName);
    expect(rows[0].nade_type).toBe("Smoke");
  });

  it("keeps two different lineups on one map apart", async () => {
    const demo = await demoFor();
    const [one, two] = await fx.players(2);

    const blob = blobOf(demo.mapName, [
      {
        gid: 1,
        thrower: one,
        origin: { x: -1912, y: 922, z: -167 },
        land: { x: -560, y: 320, z: -140 },
      },
      {
        gid: 2,
        thrower: two,
        origin: { x: 900, y: -1200, z: 10 },
        land: { x: 1400, y: -800, z: 0 },
      },
    ]);

    await (await metaFor(blob)).mine();

    const rows = await clusters();
    expect(rows.length).toBe(2);
    expect(rows.every((row) => Number(row.throws) === 1)).toBe(true);
  });

  it("counts a smoke and an HE from the same spot as different lineups", async () => {
    const demo = await demoFor();
    const thrower = await fx.player();

    const spot = { x: -1912, y: 922, z: -167 };
    const target = { x: -560, y: 320, z: -140 };

    const blob = blobOf(demo.mapName, [
      { gid: 1, thrower, origin: spot, land: target, type: "Smoke" },
      { gid: 2, thrower, origin: spot, land: target, type: "HE" },
    ]);

    await (await metaFor(blob)).mine();

    const rows = await clusters();
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.nade_type).sort()).toEqual([
      "HighExplosive",
      "Smoke",
    ]);
  });

  it("skips a grenade that never landed rather than failing the demo", async () => {
    const demo = await demoFor();
    const thrower = await fx.player();

    const blob = blobOf(demo.mapName, [
      {
        gid: 1,
        thrower,
        origin: { x: 0, y: 0, z: 0 },
        land: { x: 100, y: 100, z: 0 },
      },
      {
        gid: 2,
        thrower,
        origin: { x: 500, y: 500, z: 0 },
        land: { x: 600, y: 600, z: 0 },
        detonated: false,
      },
    ]);

    await (await metaFor(blob)).mine();

    const rows = await clusters();
    expect(rows.length).toBe(1);
  });

  it("shares its bucket with a saved lineup at the same spot", async () => {
    const demo = await demoFor();
    const thrower = await fx.player();

    const spot = { x: -1912, y: 922, z: -167 };
    const target = { x: -560, y: 320, z: -140 };

    await postgres.query(
      `INSERT INTO nade_lineups
         (map_name, nade_type, side, technique, origin_x, origin_y, origin_z,
          view_yaw, view_pitch, land_x, land_y, land_z, name, author_steam_id)
       VALUES ($1, 'Smoke', 'TERRORIST', 'Stationary', $2, $3, $4,
               45, -15, $5, $6, $7, 'Saved', $8::bigint)`,
      [
        demo.mapName,
        spot.x,
        spot.y,
        spot.z,
        target.x,
        target.y,
        target.z,
        thrower,
      ],
    );

    const blob = blobOf(demo.mapName, [
      { gid: 1, thrower, origin: spot, land: target },
    ]);

    await (await metaFor(blob)).mine();

    const rows = await clusters();
    expect(rows.length).toBe(1);
    expect(Number(rows[0].lineups)).toBe(1);

    const [saved] = await postgres.query<Array<{ lineup_bucket: string }>>(
      "SELECT lineup_bucket FROM nade_lineups LIMIT 1",
    );
    expect(saved.lineup_bucket).toBe(rows[0].lineup_bucket);
  });

  it("mines a demo once and does not double its counts on the next run", async () => {
    const demo = await demoFor();
    const thrower = await fx.player();

    const blob = blobOf(demo.mapName, [
      {
        gid: 1,
        thrower,
        origin: { x: 0, y: 0, z: 0 },
        land: { x: 400, y: 400, z: 0 },
      },
    ]);
    const meta = await metaFor(blob);

    await meta.mine();
    const first = await clusters();

    const second = await meta.mine();

    expect(second.demos).toBe(0);
    expect(await clusters()).toEqual(first);
  });

  it("records why a demo could not be mined and carries on with the rest", async () => {
    await demoFor();
    const meta = await metaFor(null);

    const result = await meta.mine();

    expect(result.demos).toBe(1);
    expect(result.throws).toBe(0);

    const [row] = await postgres.query<
      Array<{ failed_reason: string | null; throws: number }>
    >("SELECT failed_reason, throws FROM nade_demo_mines");

    expect(row.failed_reason).toContain("blob is gone");
    expect(Number(row.throws)).toBe(0);
  });

  it("stores a throw whose strength it could not name", async () => {
    const demo = await demoFor();
    const thrower = await fx.player();

    const blob = blobOf(demo.mapName, [
      {
        gid: 1,
        thrower,
        origin: { x: 0, y: 0, z: 0 },
        land: { x: 400, y: 400, z: 0 },
        // Between the Full and Half bands, so the miner refuses to name it.
        speed: 620,
      },
    ]);

    await (await metaFor(blob)).mine();

    const [row] = await postgres.query<
      Array<{ throw_strength: string | null }>
    >("SELECT throw_strength FROM nade_demo_throws");

    expect(row.throw_strength).toBeNull();
    expect((await clusters()).length).toBe(1);
  });

  it("drops a cluster whose demo was deleted out from under it", async () => {
    const demo = await demoFor();
    const thrower = await fx.player();

    const blob = blobOf(demo.mapName, [
      {
        gid: 1,
        thrower,
        origin: { x: 0, y: 0, z: 0 },
        land: { x: 400, y: 400, z: 0 },
      },
    ]);
    const meta = await metaFor(blob);

    await meta.mine();
    expect((await clusters()).length).toBe(1);

    await postgres.query("DELETE FROM match_map_demos WHERE id = $1::uuid", [
      demo.demoId,
    ]);
    await meta.refreshClusters([demo.mapName]);

    expect((await clusters()).length).toBe(0);
  });
});
