import { Logger } from "@nestjs/common";
import { CacheService } from "./../src/cache/cache.service";
import { PostgresService } from "./../src/postgres/postgres.service";
import { RconService } from "./../src/rcon/rcon.service";
import { UtilitySolverService } from "./../src/utility/utility-solver.service";
import { UtilitySolverStatus } from "./../src/utility/enums/UtilitySolverStatus";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The solver spends up to three hundred grenades and two minutes of a practice
// server, and the lineup it produces arrives by a different door entirely
// (POST /utility/ingest). So the only things worth pinning here are the refusals:
// who may start one, when, and -- the one that actually matters -- that a
// refusal says WHY, because "NoSample" and "Unsupported" are different problems
// with different fixes.
describe("utility solver (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let commands: Array<string>;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilitySolverTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199650000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    commands = [];
    await postgres.query("DELETE FROM utility_practice_sessions");
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL WHERE reserved_by_match_id IS NOT NULL",
    );
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM players");
  });

  const user = (steamId: string): User =>
    ({ steam_id: steamId, role: "user", name: "tester" }) as User;

  function rconStub(reply: string | null) {
    return {
      connect: jest.fn(async () => {
        if (reply === null) {
          return null;
        }
        return {
          send: jest.fn(async (command: string) => {
            commands.push(command);
            return reply;
          }),
        };
      }),
    } as unknown as RconService;
  }

  // Two replies in order: the calibration answer, then whatever the solve says.
  function rconScript(replies: Array<string>) {
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

  // A solve claims a per-caller budget before it spends anything, so the cache
  // has to behave like one across calls rather than a bare stub.
  function memoryCache(): {
    cache: CacheService;
    store: Map<string, unknown>;
    locks: Set<string>;
  } {
    const store = new Map<string, unknown>();
    const locks = new Set<string>();

    return {
      store,
      locks,
      cache: {
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
      } as unknown as CacheService,
    };
  }

  function service(rcon: RconService, cache?: CacheService) {
    return new UtilitySolverService(
      new Logger("UtilitySolverTest"),
      postgres,
      cache ?? memoryCache().cache,
      rcon,
    );
  }

  async function practiceSession(
    host: string,
    overrides: {
      status?: string;
      pluginRuntime?: string | null;
      withServer?: boolean;
    } = {},
  ): Promise<string> {
    const match = await fx.bareMatch();

    if (overrides.withServer !== false) {
      const [server] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM servers WHERE region = 'TestA' LIMIT 1",
      );
      await postgres.query(
        "UPDATE servers SET plugin_runtime = $2 WHERE id = $1",
        [
          server.id,
          // Distinguishes "not stated by this test" from "the server never
          // reported one", which is the case under test below.
          "pluginRuntime" in overrides ? overrides.pluginRuntime : "swiftlys2",
        ],
      );
      await postgres.query("UPDATE matches SET server_id = $2 WHERE id = $1", [
        match.matchId,
        server.id,
      ]);
    }

    const [session] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions
         (host_steam_id, map_name, region, match_id, status)
       VALUES ($1, 'de_mirage', 'TestA', $2::uuid, $3)
       RETURNING id::text AS id`,
      [host, match.matchId, overrides.status ?? "Ready"],
    );

    return session.id;
  }

  const target = { target_x: 100, target_y: 200, target_z: 30 };

  const READY = " \x04de_mirage: ready (cached) \x083 samples, worst 1.20u";
  const NO_SAMPLE =
    " \x02de_mirage: NoSample \x08nobody has thrown a grenade this session";

  describe("guards", () => {
    it("refuses a caller who is not the session host", async () => {
      const host = await fx.player();
      const other = await fx.player();
      const sessionId = await practiceSession(host);

      const answer = await service(rconStub(READY)).solve(user(other), {
        session_id: sessionId,
        ...target,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(UtilitySolverStatus.NotHost);
      expect(commands).toHaveLength(0);
    });

    it("refuses a session that is not live", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host, { status: "Starting" });

      const answer = await service(rconStub(READY)).solve(user(host), {
        session_id: sessionId,
        ...target,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(UtilitySolverStatus.NotLive);
      expect(answer.message).toMatch(/Starting/);
      expect(commands).toHaveLength(0);
    });

    it("refuses a session with no server", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host, { withServer: false });

      const answer = await service(rconStub(READY)).solve(user(host), {
        session_id: sessionId,
        ...target,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(UtilitySolverStatus.NoServer);
    });

    it("does not leak a session that does not exist", async () => {
      const host = await fx.player();

      await expect(
        service(rconStub(READY)).solve(user(host), {
          session_id: "6f8b8b3e-0000-4000-8000-000000000000",
          ...target,
        }),
      ).rejects.toThrow("practice session not found");
    });
  });

  describe("the calibration gate", () => {
    it("refuses, with the plugin's own reason, when calibration is not ready", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host);

      const answer = await service(rconStub(NO_SAMPLE)).solve(user(host), {
        session_id: sessionId,
        ...target,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(UtilitySolverStatus.NoSample);
      expect(answer.message).toMatch(/nobody has thrown a grenade/);
      // Calibration was asked; no grenade was ever spent.
      expect(commands).toEqual(["utility_solver_calibrate"]);
    });

    it("answers Unsupported on CounterStrikeSharp without touching rcon", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host, {
        pluginRuntime: "counterstrikesharp",
      });

      const answer = await service(rconStub(READY)).calibration(
        user(host),
        sessionId,
      );

      expect(answer.status).toBe(UtilitySolverStatus.Unsupported);
      expect(answer.ready).toBe(false);
      expect(answer.detail).toMatch(/SwiftlyS2/);
      expect(commands).toHaveLength(0);
    });

    it("reports an unreachable server rather than failing", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host);

      const answer = await service(rconStub(null)).calibration(
        user(host),
        sessionId,
      );

      expect(answer.status).toBe(UtilitySolverStatus.Unreachable);
      expect(answer.ready).toBe(false);
      expect(answer.detail).toBe(
        "unable to reach the practice server over rcon",
      );
    });

    // The two failures send a reader somewhere different: "cannot solve" means
    // redeploy the plugin, "could not tell" means look at the pod. A server
    // that has reported no runtime and answers nothing is the second one.
    it("does not call an unidentified server unable to solve", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host, { pluginRuntime: null });

      const answer = await service(rconStub(null)).calibration(
        user(host),
        sessionId,
      );

      expect(answer.status).toBe(UtilitySolverStatus.Unreachable);
      expect(answer.detail).toMatch(/has not reported which plugin runtime/);
      expect(answer.detail).not.toMatch(/CounterStrikeSharp/);
    });

    // The runtime column being empty is not a verdict either way, so the
    // question still gets asked and the plugin's own build answers it.
    it("still asks a server that has not reported its runtime", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host, { pluginRuntime: null });

      const answer = await service(
        rconStub(
          " \x02de_mirage: Unsupported \x08the solver needs a grenade emit API",
        ),
      ).calibration(user(host), sessionId);

      expect(commands).toEqual(["utility_solver_calibrate"]);
      expect(answer.status).toBe(UtilitySolverStatus.Unsupported);
      expect(answer.ready).toBe(false);
    });

    it("reads a cached ready verdict", () => {
      expect(UtilitySolverService.readCalibration(READY)).toEqual({
        status: UtilitySolverStatus.Ready,
        ready: true,
        detail: "de_mirage: ready (cached) 3 samples, worst 1.20u",
      });
    });

    it("does not mistake a busy solver for a verdict", () => {
      const answer = UtilitySolverService.readCalibration(
        " \x02solve is already running",
      );

      expect(answer.status).toBe(UtilitySolverStatus.Busy);
      expect(answer.ready).toBe(false);
    });

    it("treats an in-progress calibration as no verdict yet", () => {
      const answer = UtilitySolverService.readCalibration(
        " \x08calibrating the solver on de_mirage...",
      );

      expect(answer.status).toBe(UtilitySolverStatus.Unknown);
      expect(answer.ready).toBe(false);
    });
  });

  // A solve is the most expensive thing a caller can ask of a practice pod --
  // 300 grenades and two minutes -- and it was the one path in the module with
  // no cap on it.
  describe("budget", () => {
    it("refuses a second solve while the first could still be running", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host);
      const { cache } = memoryCache();

      const first = await service(
        rconScript([READY, " \x04solving Smoke"]),
        cache,
      ).solve(user(host), { session_id: sessionId, ...target });
      expect(first.accepted).toBe(true);

      const second = await service(
        rconScript([READY, " \x04solving Smoke"]),
        cache,
      ).solve(user(host), { session_id: sessionId, ...target });

      expect(second.accepted).toBe(false);
      expect(second.status).toBe("Busy");
      expect(second.message).toMatch(/already have a solve running/i);
    });

    it("does not spend another caller's budget", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host);
      const { cache } = memoryCache();

      await service(rconScript([READY, " \x04solving Smoke"]), cache).solve(
        user(host),
        { session_id: sessionId, ...target },
      );

      const otherHost = await fx.player();
      const otherSession = await practiceSession(otherHost);

      const answer = await service(
        rconScript([READY, " \x04solving Smoke"]),
        cache,
      ).solve(user(otherHost), { session_id: otherSession, ...target });

      expect(answer.accepted).toBe(true);
    });

    it("stops at the hourly cap and says when it clears", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host);
      const { cache, locks } = memoryCache();

      for (let attempt = 0; attempt < 6; attempt++) {
        // The concurrency lock is the other half of the budget; release it so
        // this exercises the hourly counter rather than re-proving the lock.
        locks.clear();
        const answer = await service(
          rconScript([READY, " \x04solving Smoke"]),
          cache,
        ).solve(user(host), { session_id: sessionId, ...target });
        expect(answer.accepted).toBe(true);
      }

      locks.clear();
      const capped = await service(
        rconScript([READY, " \x04solving Smoke"]),
        cache,
      ).solve(user(host), { session_id: sessionId, ...target });

      expect(capped.accepted).toBe(false);
      expect(capped.status).toBe("Busy");
      expect(capped.message).toMatch(/all 6 solves for this hour/i);
      expect(capped.message).toMatch(/minute/);
    });
  });

  describe("issuing the solve", () => {
    it("accepts and returns without waiting for a lineup", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host);

      const answer = await service(
        rconScript([READY, " \x04solving Smoke (up to 300 grenades / 120s)"]),
      ).solve(user(host), {
        session_id: sessionId,
        ...target,
        from_x: -10,
        from_y: -20,
        from_z: -30,
        utility_type: "Smoke",
        tolerance: 40,
      });

      expect(answer.accepted).toBe(true);
      expect(answer.status).toBe(UtilitySolverStatus.Solving);
      expect(commands[0]).toBe("utility_solver_calibrate");
      expect(commands[1]).toBe(
        `utility_solver_solve target=100.00,200.00,30.00 from=-10.00,-20.00,-30.00 utility=Smoke steam=${host} tolerance=40.00`,
      );
    });

    it("collapses a name the plugin's argument parser would split", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host);

      await service(rconScript([READY, "solving"])).solve(user(host), {
        session_id: sessionId,
        ...target,
        name: "A site cross smoke",
      });

      expect(commands[1]).toContain("name=A_site_cross_smoke");
    });

    it("reports an unreachable server rather than claiming a solve started", async () => {
      const host = await fx.player();
      const sessionId = await practiceSession(host);

      const answer = await service(rconStub(null)).solve(user(host), {
        session_id: sessionId,
        ...target,
      });

      expect(answer.accepted).toBe(false);
      expect(answer.status).toBe(UtilitySolverStatus.Unreachable);
    });
  });
});
