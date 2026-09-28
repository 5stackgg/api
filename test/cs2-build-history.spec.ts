import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  GameServerNodeService,
  GamedataValidationResult,
} from "./../src/game-server-node/game-server-node.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Validation history has to outlive the game version it validated:
// CheckGameUpdate deletes a build's game_versions row as soon as Steam stops
// listing it, which is exactly when the next build wants to be compared to it.
describe("CS2 build history (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let redis: { set: jest.Mock; del: jest.Mock; exists: jest.Mock };

  beforeAll(async () => {
    db = await bootMigratedDb("Cs2BuildHistoryTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM gamedata_signature_validations");
    await postgres.query("DELETE FROM map_asset_builds");
    await postgres.query("DELETE FROM game_server_nodes");
    await postgres.query("DELETE FROM game_versions");
    await postgres.query(
      `INSERT INTO server_regions (value, description)
       VALUES ('TestRegion', 'TestRegion') ON CONFLICT (value) DO NOTHING`,
    );
    await postgres.query(
      `INSERT INTO game_versions (build_id, version, description, current, updated_at)
       VALUES (25537370, '1.0', 'current', true, now()),
              (24957633, '0.9', 'previous', null, now())`,
    );
    await postgres.query(
      `INSERT INTO game_server_nodes (id, status, enabled, region, build_id)
       VALUES ('node-a', 'Online', true, 'TestRegion', 25537370),
              ('node-b', 'Online', true, 'TestRegion', 25537370),
              ('node-old', 'Online', true, 'TestRegion', 24957633),
              ('node-off', 'Offline', true, 'TestRegion', 25537370)`,
    );
    redis = {
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(0),
    };
  });

  const service = (validation?: () => Promise<GamedataValidationResult>) => {
    const nodes = new GameServerNodeService(
      new Logger("Cs2BuildHistoryTest"),
      { get: () => ({ namespace: "5stack" }) } as never,
      {} as never,
      { getConnection: () => redis } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      postgres,
      { getJob: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const defaultValidation = async (): Promise<GamedataValidationResult> => ({
      status: "pass",
      broken: [],
      results: [],
    });
    (nodes as any).runGamedataValidation = jest.fn(
      validation ?? defaultValidation,
    );
    return nodes;
  };

  const validation = async (buildId: number) => {
    const [found] = await postgres.query<
      Array<{
        status: string;
        started_at: Date | null;
        validated_at: Date | null;
        game_server_node_id: string | null;
        trigger: string | null;
        previous_build_id: number | null;
        changes: Record<string, any> | null;
      }>
    >(
      `SELECT status, started_at, validated_at, game_server_node_id, trigger,
              previous_build_id, changes
         FROM gamedata_signature_validations
        WHERE build_id = $1`,
      [buildId],
    );
    return found;
  };

  it("keeps a validation after its game version is deleted", async () => {
    await service().validateGamedata("node-old", 24957633);

    await postgres.query(`DELETE FROM game_versions WHERE build_id = 24957633`);

    expect((await validation(24957633)).status).toBe("pass");
  });

  it("keeps one row per build, overwritten by each run", async () => {
    await service().validateGamedata("node-a", 25537370, "public", {
      trigger: "auto",
    });
    await service().validateGamedata("node-b", 25537370, "public", {
      trigger: "manual",
    });

    const [{ count }] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*) FROM gamedata_signature_validations WHERE build_id = 25537370`,
    );
    expect(Number(count)).toBe(1);
    expect(await validation(25537370)).toMatchObject({
      status: "pass",
      game_server_node_id: "node-b",
      trigger: "manual",
    });
  });

  it("is visible as running while the job runs", async () => {
    let during: Awaited<ReturnType<typeof validation>>;
    await service(async () => {
      during = await validation(25537370);
      return { status: "pass", broken: [], results: [] };
    }).validateGamedata("node-a", 25537370);

    expect(during.status).toBe("running");
    expect(during.started_at).toBeInstanceOf(Date);
    expect(during.validated_at).toBeNull();
    expect((await validation(25537370)).validated_at).toBeInstanceOf(Date);
  });

  it("records an error instead of staying running when the job throws", async () => {
    const outcome = await service(async () => {
      throw new Error("forbidden");
    }).validateGamedata("node-a", 25537370);

    expect(outcome.result).toMatchObject({
      status: "error",
      error: "forbidden",
    });
    expect(outcome.changes).toBeNull();
    expect((await validation(25537370)).status).toBe("error");
    expect(redis.del).toHaveBeenCalled();
  });

  it("compares with the previous build and stores the difference", async () => {
    const connect = {
      set: "fivestack",
      signature: "ConnectClient",
      kind: "signature" as const,
      runtimes: ["swiftlys2" as const],
    };
    await service(async () => ({
      status: "fail",
      broken: [{ ...connect, count: 0, ok: false }],
      results: [{ ...connect, count: 0, ok: false }],
    })).validateGamedata("node-old", 24957633);

    await service(async () => ({
      status: "pass",
      broken: [],
      results: [{ ...connect, count: 1, ok: true }],
    })).validateGamedata("node-a", 25537370);

    const current = await validation(25537370);
    expect(current.previous_build_id).toBe(24957633);
    expect(current.changes).toMatchObject({
      comparable: true,
      counts: { checked: 1, broken: 0, warnings: 0, skipped: 0 },
      newly_broken: [],
      fixed: [{ signature: "ConnectClient", previous_count: 0, count: 1 }],
    });
  });

  it("never compares with a run that could not validate", async () => {
    await service(async () => {
      throw new Error("boom");
    }).validateGamedata("node-old", 24957633);

    await service().validateGamedata("node-a", 25537370);

    expect(await validation(25537370)).toMatchObject({
      previous_build_id: null,
      changes: { comparable: false },
    });
  });

  it("leaves the row alone when another run holds the lock", async () => {
    redis.set.mockResolvedValueOnce(null);

    await expect(
      service().validateGamedata("node-a", 25537370),
    ).resolves.toBeNull();
    expect(await validation(25537370)).toBeUndefined();
  });

  it("only knows automatic and manual triggers", async () => {
    await expect(
      postgres.query(
        `INSERT INTO gamedata_signature_validations (build_id, branch, status, trigger)
         VALUES (1, 'public', 'pass', 'cron')`,
      ),
    ).rejects.toThrow(/gamedata_signature_validations_trigger_check/);
  });

  it("forgets the node, not the history, when a node is deleted", async () => {
    await service().validateGamedata("node-b", 25537370);

    await postgres.query(`DELETE FROM game_server_nodes WHERE id = 'node-b'`);

    expect(await validation(25537370)).toMatchObject({
      status: "pass",
      game_server_node_id: null,
    });
  });

  it("keeps a real result when a re-run could not validate at all", async () => {
    await service().validateGamedata("node-a", 25537370);
    const before = await validation(25537370);

    const outcome = await service(async () => ({
      status: "error",
      broken: [],
      error: "no pod was scheduled for the validation job",
    })).validateGamedata("node-a", 25537370);

    expect(outcome.result.status).toBe("error");
    const after = await validation(25537370);
    expect(after.status).toBe("pass");
    expect(after.validated_at).toEqual(before.validated_at);
  });

  it("compares with a run whose Swiftly gamedata could not be fetched", async () => {
    const connect = {
      set: "fivestack",
      signature: "ConnectClient",
      kind: "signature" as const,
    };
    await service(async () => ({
      status: "error",
      broken: [],
      swiftly: { error: "could not fetch SwiftlyS2 gamedata" },
      results: [{ ...connect, count: 1, ok: true }],
    })).validateGamedata("node-old", 24957633);

    expect((await validation(24957633)).changes).toMatchObject({
      comparable: false,
      counts: { checked: 1 },
    });

    await service(async () => ({
      status: "fail",
      broken: [{ ...connect, count: 0, ok: false }],
      results: [{ ...connect, count: 0, ok: false }],
    })).validateGamedata("node-a", 25537370);

    expect(await validation(25537370)).toMatchObject({
      previous_build_id: 24957633,
      changes: { newly_broken: [{ signature: "ConnectClient" }] },
    });
  });

  describe("automatic validation", () => {
    const originalDomain = process.env.WEB_DOMAIN;

    beforeEach(() => {
      process.env.WEB_DOMAIN = "5stack.gg";
    });

    afterEach(() => {
      process.env.WEB_DOMAIN = originalDomain;
    });

    const auto = (queue: { add: jest.Mock }) => {
      const nodes = service();
      (nodes as any).validateGamedataQueue = queue;
      (nodes as any).getCurrentBuild = async () => 25537370;
      return (nodes as any).queueGamedataValidation(
        "node-b",
        25537370,
      ) as Promise<boolean>;
    };

    it("queues the first validation of a build", async () => {
      const queue = { add: jest.fn().mockResolvedValue({}) };

      await expect(auto(queue)).resolves.toBe(true);
      expect(queue.add.mock.calls[0][1]).toMatchObject({
        buildMapAssets: true,
        trigger: "auto",
      });
    });

    it("leaves the map-asset build chained behind a run in progress", async () => {
      await postgres.query(
        `INSERT INTO gamedata_signature_validations (build_id, branch, status, started_at)
         VALUES (25537370, 'public', 'running', now())`,
      );
      const queue = { add: jest.fn() };

      await expect(auto(queue)).resolves.toBe(true);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("hands the map-asset build back when the run died with the api", async () => {
      await postgres.query(
        `INSERT INTO gamedata_signature_validations (build_id, branch, status, started_at)
         VALUES (25537370, 'public', 'running', now() - interval '2 hours')`,
      );

      await expect(auto({ add: jest.fn() })).resolves.toBe(false);
    });

    it("does not validate a finished build again", async () => {
      await service().validateGamedata("node-a", 25537370);

      await expect(auto({ add: jest.fn() })).resolves.toBe(false);
    });
  });

  describe("resolveBuildNode", () => {
    it("picks an online node on the build", async () => {
      await expect(service().resolveBuildNode(25537370)).resolves.toBe(
        "node-a",
      );
    });

    it("steers clear of a node busy with the other job", async () => {
      await postgres.query(
        `INSERT INTO map_asset_builds (build_id, status, game_server_node_id)
         VALUES ('25537370', 'Building', 'node-a')`,
      );

      await expect(service().resolveBuildNode(25537370)).resolves.toBe(
        "node-b",
      );
    });

    it("runs on the node that was asked for", async () => {
      await expect(
        service().resolveBuildNode(25537370, "node-b"),
      ).resolves.toBe("node-b");
    });

    it.each([
      ["node-old", "node-old is on build 24957633, not 25537370"],
      ["node-off", "node-off is Offline"],
      ["node-missing", "Game server node node-missing does not exist"],
    ])("refuses %s", async (nodeId, reason) => {
      await expect(
        service().resolveBuildNode(25537370, nodeId),
      ).rejects.toThrow(reason);
    });

    it("says so when no node is on the build", async () => {
      await postgres.query(
        `UPDATE game_server_nodes SET status = 'Offline' WHERE build_id = 25537370`,
      );

      await expect(service().resolveBuildNode(25537370)).rejects.toThrow(
        "No online game server node is on CS2 build 25537370",
      );
    });
  });
});
