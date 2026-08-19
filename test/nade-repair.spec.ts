import { Logger } from "@nestjs/common";
import { CacheService } from "./../src/cache/cache.service";
import { PostgresService } from "./../src/postgres/postgres.service";
import { RconService } from "./../src/rcon/rcon.service";
import {
  NadeLineupsService,
  NadeServerContext,
} from "./../src/nades/nade-lineups.service";
import { NadeRepairService } from "./../src/nades/nade-repair.service";
import { NadeSolverService } from "./../src/nades/nade-solver.service";
import { NadeSolverStatus } from "./../src/nades/enums/NadeSolverStatus";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Repair is the join between two things that already worked separately: a drift
// scan that says a lineup moved, and a solver that can find a throw onto a
// point. What is worth pinning is the refusals -- a verdict that a re-solve
// cannot act on must say so rather than spend a server's two minutes -- and the
// half nobody sees, which is that the lineup the solve eventually posts finds
// its way back to the one it repaired without touching a thing on it.
describe("nade lineup repair (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let commands: Array<string>;

  const ORIGIN = { x: -1912, y: 922, z: -167 };
  const LAND = { x: -560, y: 320, z: -140 };

  const READY = " \x04de_mirage: ready (cached) 3 samples, worst 1.20u";
  const SOLVING = " \x04solving Smoke (up to 300 grenades / 120s)";

  beforeAll(async () => {
    db = await bootMigratedDb("NadeRepairTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199620000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    commands = [];
    await postgres.query("DELETE FROM nade_lineup_repairs");
    await postgres.query("DELETE FROM nade_drift_scans");
    await postgres.query("DELETE FROM nade_lineups");
    await postgres.query("DELETE FROM nade_practice_sessions");
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL WHERE reserved_by_match_id IS NOT NULL",
    );
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM players");
  });

  const user = (steamId: string): User =>
    ({ steam_id: steamId, role: "user", name: "tester" }) as User;

  function rcon(replies: Array<string>): RconService {
    let index = 0;
    return {
      connect: jest.fn(async () => ({
        send: jest.fn(async (command: string) => {
          commands.push(command);
          return replies[Math.min(index++, replies.length - 1)];
        }),
      })),
    } as unknown as RconService;
  }

  function lineupsService(): NadeLineupsService {
    const store = new Map<string, unknown>();

    return new NadeLineupsService(
      new Logger("NadeRepairTest"),
      postgres,
      {
        uploadTrajectory: jest.fn(async (): Promise<string> => "key"),
        removeTrajectories: jest.fn(async (): Promise<void> => undefined),
      } as unknown as never,
      {
        get: jest.fn(async (key: string, fallback?: unknown) =>
          store.has(key) ? store.get(key) : fallback,
        ),
        put: jest.fn(async (key: string, value: unknown) => {
          store.set(key, value);
          return true;
        }),
      } as unknown as never,
    );
  }

  // A repair spends the solver's budget, so every constructed service gets its
  // own cache: sharing one would make the second repair in a file look like a
  // concurrent solve by the same caller.
  function solverCache(): CacheService {
    const store = new Map<string, unknown>();
    const locks = new Set<string>();

    return {
      get: jest.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? store.get(key) : fallback,
      ),
      put: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      forget: jest.fn(async (key: string) => locks.delete(key)),
      acquireLock: jest.fn(async (key: string) => {
        if (locks.has(key)) {
          return false;
        }
        locks.add(key);
        return true;
      }),
    } as unknown as CacheService;
  }

  function service(
    replies: Array<string> = [READY, SOLVING],
    lineups = lineupsService(),
  ): NadeRepairService {
    return new NadeRepairService(
      new Logger("NadeRepairTest"),
      postgres,
      new NadeSolverService(
        new Logger("NadeRepairTest"),
        postgres,
        solverCache(),
        rcon(replies),
      ),
      lineups,
    );
  }

  async function insertLineup(
    author: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      map_name: "de_mirage",
      nade_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: ORIGIN.x,
      origin_y: ORIGIN.y,
      origin_z: ORIGIN.z,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: LAND.x,
      land_y: LAND.y,
      land_z: LAND.z,
      name: "Window from T spawn",
      visibility: "Public",
      author_steam_id: author,
      initial_pos_x: -1900,
      initial_pos_y: 930,
      initial_pos_z: -100,
      initial_vel_x: 500,
      initial_vel_y: 200,
      initial_vel_z: 300,
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO nade_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  async function verdictFor(
    lineupId: string,
    verdict: string,
    requester: string,
    distance: number | null = 91.5,
  ): Promise<string> {
    const [scan] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO nade_drift_scans (map_name, requested_by_steam_id)
       VALUES ('de_mirage', $1::bigint) RETURNING id`,
      [requester],
    );
    await postgres.query(
      `INSERT INTO nade_drift_results
         (nade_drift_scan_id, nade_lineup_id, verdict, severity, distance)
       VALUES ($1::uuid, $2::uuid, $3, 'major', $4)`,
      [scan.id, lineupId, verdict, distance],
    );
    return scan.id;
  }

  async function practiceSession(
    host: string,
    mapName = "de_mirage",
  ): Promise<{ sessionId: string; matchId: string }> {
    const match = await fx.bareMatch();
    const [server] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM servers WHERE region = 'TestA' LIMIT 1",
    );
    await postgres.query(
      "UPDATE servers SET plugin_runtime = 'swiftlys2' WHERE id = $1",
      [server.id],
    );
    await postgres.query("UPDATE matches SET server_id = $2 WHERE id = $1", [
      match.matchId,
      server.id,
    ]);

    const [session] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO nade_practice_sessions
         (host_steam_id, map_name, region, match_id, status)
       VALUES ($1, $2, 'TestA', $3::uuid, 'Ready')
       RETURNING id::text AS id`,
      [host, mapName, match.matchId],
    );

    return { sessionId: session.id, matchId: match.matchId };
  }

  const repairRows = async () =>
    await postgres.query<
      Array<{
        id: string;
        nade_lineup_id: string;
        status: string;
        repaired_nade_lineup_id: string | null;
        drift_distance: number | null;
        repaired_at: Date | null;
      }>
    >(
      `SELECT id::text AS id, nade_lineup_id::text AS nade_lineup_id, status,
              repaired_nade_lineup_id::text AS repaired_nade_lineup_id,
              drift_distance, repaired_at
         FROM nade_lineup_repairs ORDER BY created_at ASC`,
    );

  describe("refusing what a re-solve cannot fix", () => {
    it("refuses a lineup no scan has judged", async () => {
      const host = await fx.player();
      const lineup = await insertLineup(host);
      const { sessionId } = await practiceSession(host);

      const answer = await service().repair(user(host), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(NadeSolverStatus.NotScanned);
      // Not a single grenade, and not even a calibration round trip.
      expect(commands).toHaveLength(0);
      expect(await repairRows()).toHaveLength(0);
    });

    // 'broken' means the scan could not land the throw anywhere on the new mesh,
    // so there is no point to aim at; 'unsimulatable' means the scan could not
    // fly it at all, which is not evidence the map changed.
    it.each([
      ["broken", /no point to re-solve onto/],
      ["unsimulatable", /says nothing about whether the map moved/],
      ["unchanged", /nothing to repair/],
    ])("refuses a %s verdict", async (verdict, reason) => {
      const host = await fx.player();
      const lineup = await insertLineup(host);
      await verdictFor(lineup, verdict, host);
      const { sessionId } = await practiceSession(host);

      const answer = await service().repair(user(host), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(NadeSolverStatus.NotMoved);
      expect(answer.message).toMatch(reason);
      expect(commands).toHaveLength(0);
    });

    it("refuses a lineup whose seed has gone", async () => {
      const host = await fx.player();
      const lineup = await insertLineup(host, {
        initial_vel_x: null,
        initial_vel_y: null,
        initial_vel_z: null,
      });
      await verdictFor(lineup, "moved", host);
      const { sessionId } = await practiceSession(host);

      const answer = await service().repair(user(host), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(NadeSolverStatus.Seedless);
      expect(commands).toHaveLength(0);
    });

    it("refuses to aim one map's coordinates at another map", async () => {
      const host = await fx.player();
      const lineup = await insertLineup(host);
      await verdictFor(lineup, "moved", host);
      const { sessionId } = await practiceSession(host, "de_nuke");

      const answer = await service().repair(user(host), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(NadeSolverStatus.WrongMap);
      expect(commands).toHaveLength(0);
    });

    it("does not leak a lineup the caller cannot see", async () => {
      const author = await fx.player();
      const stranger = await fx.player();
      const lineup = await insertLineup(author, { visibility: "Private" });
      await verdictFor(lineup, "moved", author);
      const { sessionId } = await practiceSession(stranger);

      await expect(
        service().repair(user(stranger), {
          nade_lineup_id: lineup,
          session_id: sessionId,
        }),
      ).rejects.toThrow("lineup not found");
    });

    // Every gate the solver applies to a bare solve applies here unchanged; a
    // repair spends exactly the same two minutes of the same server.
    it("leaves the solver's own refusals in place", async () => {
      const host = await fx.player();
      const other = await fx.player();
      const lineup = await insertLineup(host);
      await verdictFor(lineup, "moved", host);
      const { sessionId } = await practiceSession(host);

      const answer = await service().repair(user(other), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(NadeSolverStatus.NotHost);
      expect(await repairRows()).toHaveLength(0);
    });

    it("records nothing when the calibration gate turns the solve away", async () => {
      const host = await fx.player();
      const lineup = await insertLineup(host);
      await verdictFor(lineup, "moved", host);
      const { sessionId } = await practiceSession(host);

      const answer = await service([
        " \x02de_mirage: NoSample \x08nobody has thrown a grenade this session",
      ]).repair(user(host), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(NadeSolverStatus.NoSample);
      // A Requested row left behind here would claim the next lineup this
      // player saves in this session as the repair.
      expect(await repairRows()).toHaveLength(0);
    });
  });

  describe("issuing the re-solve", () => {
    it("aims at the drifted lineup's own landing point, from its own stance", async () => {
      const host = await fx.player();
      const lineup = await insertLineup(host);
      await verdictFor(lineup, "moved", host);
      const { sessionId } = await practiceSession(host);

      const answer = await service().repair(user(host), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });

      expect(answer.accepted).toBe(true);
      expect(answer.status).toBe(NadeSolverStatus.Solving);
      expect(commands[0]).toBe("nade_solver_calibrate");
      expect(commands[1]).toContain(
        `target=${LAND.x.toFixed(2)},${LAND.y.toFixed(2)},${LAND.z.toFixed(2)}`,
      );
      expect(commands[1]).toContain(
        `from=${ORIGIN.x.toFixed(2)},${ORIGIN.y.toFixed(2)},${ORIGIN.z.toFixed(2)}`,
      );
      expect(commands[1]).toContain("utility=Smoke");
      // The practice success radius is the bar a throw clears to count as this
      // lineup, so it is the bar a repair clears to be this lineup.
      expect(commands[1]).toContain("tolerance=96.00");

      const [repair] = await repairRows();
      expect(repair.status).toBe("Requested");
      expect(repair.nade_lineup_id).toBe(lineup);
      expect(Number(repair.drift_distance)).toBeCloseTo(91.5, 5);
      expect(commands[1]).toContain(`name=repair-${repair.id}`);
    });

    it("keeps one open ask per person per lineup", async () => {
      const host = await fx.player();
      const lineup = await insertLineup(host);
      await verdictFor(lineup, "moved", host);
      const { sessionId } = await practiceSession(host);

      await service().repair(user(host), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });
      await service().repair(user(host), {
        nade_lineup_id: lineup,
        session_id: sessionId,
      });

      const rows = await repairRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("Requested");
    });
  });

  // The half nobody sees. The solve answers minutes later by posting an ordinary
  // lineup to /nades/ingest, and this is where that lineup is recognised as the
  // answer to a repair rather than somebody's own throw.
  describe("when the solved lineup arrives", () => {
    async function ingestRepaired(
      lineups: NadeLineupsService,
      context: NadeServerContext,
      author: string,
      name: string,
    ) {
      return await lineups.ingest(context, {
        author_steam_id: author,
        nade_type: "Smoke",
        side: "TERRORIST",
        technique: "Jump",
        origin_x: ORIGIN.x + 4,
        origin_y: ORIGIN.y,
        origin_z: ORIGIN.z,
        view_yaw: 134.9,
        view_pitch: -12.9,
        land_x: LAND.x + 2,
        land_y: LAND.y - 1,
        land_z: LAND.z,
        name,
      });
    }

    async function repaired(host: string) {
      const lineups = lineupsService();
      const original = await insertLineup(host);
      await verdictFor(original, "moved", host);
      const { sessionId, matchId } = await practiceSession(host);

      await service([READY, SOLVING], lineups).repair(user(host), {
        nade_lineup_id: original,
        session_id: sessionId,
      });

      const [repair] = await repairRows();

      return {
        lineups,
        original,
        repair,
        context: {
          serverId: "00000000-0000-4000-8000-000000000000",
          matchId,
          mapName: "de_mirage",
          lineupSteamIds: [host],
        } as NadeServerContext,
      };
    }

    it("links the new lineup back to the one it repaired", async () => {
      const host = await fx.player();
      const { lineups, original, repair, context } = await repaired(host);

      const { id: fixed } = await ingestRepaired(
        lineups,
        context,
        host,
        `repair-${repair.id}`,
      );

      const [row] = await postgres.query<
        Array<{ forked_from: string | null; name: string; source: string }>
      >(
        `SELECT forked_from_nade_lineup_id::text AS forked_from, name,
                origin_source AS source
           FROM nade_lineups WHERE id = $1::uuid`,
        [fixed],
      );

      expect(row.forked_from).toBe(original);
      expect(row.source).toBe("plugin");
      // The correlation id is not a name anybody wants in their library.
      expect(row.name).toBe("Window from T spawn");

      const [closed] = await repairRows();
      expect(closed.status).toBe("Repaired");
      expect(closed.repaired_nade_lineup_id).toBe(fixed);
      expect(closed.repaired_at).not.toBeNull();
    });

    // The whole reason a repair is a new row: everything hanging off the
    // original is a claim about ITS coordinates, and none of it carries a
    // geometry version that could survive a rewrite.
    it("destroys nothing the original had earned", async () => {
      const host = await fx.player();
      const fan = await fx.player();
      const { lineups, original, repair, context } = await repaired(host);

      await postgres.query(
        "INSERT INTO nade_lineup_votes (nade_lineup_id, steam_id, vote) VALUES ($1::uuid, $2::bigint, 1)",
        [original, fan],
      );
      await postgres.query(
        "INSERT INTO nade_lineup_favorites (nade_lineup_id, steam_id) VALUES ($1::uuid, $2::bigint)",
        [original, fan],
      );
      await postgres.query(
        `INSERT INTO nade_lineup_progress
           (nade_lineup_id, steam_id, attempts, successes, mastered_at)
         VALUES ($1::uuid, $2::bigint, 9, 7, now())`,
        [original, fan],
      );

      await ingestRepaired(lineups, context, host, `repair-${repair.id}`);

      const [row] = await postgres.query<
        Array<{
          land_x: number;
          upvotes: number;
          favorites: number;
          progress: string;
          verdicts: string;
        }>
      >(
        `SELECT l.land_x, l.upvotes, l.favorites,
                (SELECT count(*)::text FROM nade_lineup_progress p
                  WHERE p.nade_lineup_id = l.id) AS progress,
                (SELECT count(*)::text FROM nade_drift_results d
                  WHERE d.nade_lineup_id = l.id AND d.verdict = 'moved') AS verdicts
           FROM nade_lineups l WHERE l.id = $1::uuid`,
        [original],
      );

      expect(Number(row.land_x)).toBeCloseTo(LAND.x, 5);
      expect(Number(row.upvotes)).toBe(1);
      expect(Number(row.favorites)).toBe(1);
      expect(Number(row.progress)).toBe(1);
      // The lineup was drifted, and it still says so.
      expect(Number(row.verdicts)).toBe(1);
    });

    it("does not claim an ordinary lineup saved in the same session", async () => {
      const host = await fx.player();
      const { lineups, repair, context } = await repaired(host);

      const { id: unrelated } = await ingestRepaired(
        lineups,
        context,
        host,
        "Some other smoke",
      );

      const [row] = await postgres.query<Array<{ forked_from: string | null }>>(
        `SELECT forked_from_nade_lineup_id::text AS forked_from
           FROM nade_lineups WHERE id = $1::uuid`,
        [unrelated],
      );

      expect(row.forked_from).toBeNull();
      expect((await repairRows())[0].status).toBe("Requested");
      expect(repair.status).toBe("Requested");
    });

    it("will not claim a repair the window has closed on", async () => {
      const host = await fx.player();
      const { lineups, repair, context } = await repaired(host);

      await postgres.query(
        "UPDATE nade_lineup_repairs SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid",
        [repair.id],
      );

      const { id: late } = await ingestRepaired(
        lineups,
        context,
        host,
        `repair-${repair.id}`,
      );

      const [row] = await postgres.query<Array<{ forked_from: string | null }>>(
        `SELECT forked_from_nade_lineup_id::text AS forked_from
           FROM nade_lineups WHERE id = $1::uuid`,
        [late],
      );

      expect(row.forked_from).toBeNull();
    });

    it("will not let one player claim another's repair", async () => {
      const host = await fx.player();
      const thief = await fx.player();
      const { lineups, repair, context } = await repaired(host);

      const { id: stolen } = await ingestRepaired(
        lineups,
        { ...context, lineupSteamIds: [host, thief] },
        thief,
        `repair-${repair.id}`,
      );

      const [row] = await postgres.query<Array<{ forked_from: string | null }>>(
        `SELECT forked_from_nade_lineup_id::text AS forked_from
           FROM nade_lineups WHERE id = $1::uuid`,
        [stolen],
      );

      expect(row.forked_from).toBeNull();
      expect((await repairRows())[0].status).toBe("Requested");
    });
  });
});
