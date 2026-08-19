import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityPlaybooksService } from "./../src/utility/utility-playbooks.service";
import { UtilityPracticeService } from "./../src/utility/utility-practice.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A practice server is a second pool that matchmaking must never see and that
// must never hand out its own connect string: the whole point of routing a
// practice session through a match is that only assigned players get in.
describe("utility practice servers (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityPracticeServersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199700000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_practice_sessions");
    await postgres.query("DELETE FROM servers WHERE type = 'Practice'");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM settings WHERE name LIKE 'public.utility_%'");
  });

  async function practiceServer(
    options: { region?: string; connected?: boolean; enabled?: boolean } = {},
  ): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, enabled, connected, region, type, is_dedicated)
       VALUES ('127.0.0.1', $1, '\\x00'::bytea, 27960, $2, $3, $4, 'Practice', true)
       RETURNING id::text AS id`,
      [
        fx.nextName("practice-"),
        options.enabled ?? true,
        options.connected ?? true,
        options.region ?? "TestA",
      ],
    );
    return row.id;
  }

  function makeService(): UtilityPracticeService {
    return new UtilityPracticeService(
      new Logger("UtilityPracticeServersTest"),
      postgres,
      {} as never,
      {
        acquireLock: jest.fn(async (): Promise<boolean> => true),
        forget: jest.fn(async (): Promise<boolean> => true),
        get: jest.fn(async (_key: string, fallback: unknown) => fallback),
        put: jest.fn(async (): Promise<void> => undefined),
      } as unknown as never,
      {
        countFreeOnDemandServers: jest.fn(async (): Promise<number> => 10),
        sendUtilityPracticeRefresh: jest.fn(async (): Promise<void> => undefined),
        updateMatchStatus: jest.fn(async (): Promise<void> => undefined),
      } as unknown as never,
      new UtilityPlaybooksService(postgres),
      {
        notifyPlayers: jest.fn(async (): Promise<number> => 0),
      } as unknown as never,
      {
        get: jest.fn(() => ({ webDomain: "https://5stack.test" })),
      } as unknown as never,
    );
  }

  describe("a practice server is not a match server", () => {
    it("hands out no connection string", async () => {
      const id = await practiceServer();

      const [row] = await postgres.query<Array<{ connect: string | null }>>(
        `SELECT get_server_connection_string(s.*, '{}'::json) AS connect
           FROM servers s WHERE s.id = $1::uuid`,
        [id],
      );

      expect(row.connect).toBeNull();
    });

    it("hands out no connection link", async () => {
      const id = await practiceServer();

      const [row] = await postgres.query<Array<{ link: string | null }>>(
        `SELECT get_server_connection_link(s.*, '{}'::json) AS link
           FROM servers s WHERE s.id = $1::uuid`,
        [id],
      );

      expect(row.link).toBeNull();
    });

    it("is invisible to the region's available-server count", async () => {
      const before = await availableInRegion("TestA");
      await practiceServer();

      expect(await availableInRegion("TestA")).toBe(before);
    });
  });

  describe("reservations", () => {
    it("counts a reserved practice server as unavailable", async () => {
      const id = await practiceServer();
      const host = await fx.player();
      const matchId = await someMatch(host);

      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $2::uuid WHERE id = $1::uuid",
        [id, matchId],
      );

      const [row] = await postgres.query<Array<{ available: boolean }>>(
        "SELECT is_server_available($1::uuid, $2::uuid) AS available",
        [await someMatch(await fx.player()), id],
      );

      expect(row.available).toBe(false);
    });
  });

  describe("choosing one", () => {
    it("refuses a server that is not a practice server", async () => {
      const [row] = await postgres.query<Array<{ id: string }>>(
        "SELECT id::text AS id FROM servers WHERE type = 'Ranked' LIMIT 1",
      );

      await expect(
        makeService()["practiceServer"](row.id),
      ).rejects.toThrow(/not available/);
    });

    it("refuses a disconnected practice server", async () => {
      const id = await practiceServer({ connected: false });

      await expect(
        makeService()["practiceServer"](id),
      ).rejects.toThrow(/not available/);
    });

    it("refuses one that another session already holds", async () => {
      const id = await practiceServer();
      const matchId = await someMatch(await fx.player());

      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $2::uuid WHERE id = $1::uuid",
        [id, matchId],
      );

      await expect(
        makeService()["practiceServer"](id),
      ).rejects.toThrow(/already in use/);
    });

    it("auto-picks a free one in the region", async () => {
      const id = await practiceServer({ region: "TestA" });

      const picked = await makeService()["freePracticeServer"]("TestA");

      expect(picked).toEqual({ id, region: "TestA" });
    });

    it("picks nothing when every practice server is taken", async () => {
      const id = await practiceServer();
      const matchId = await someMatch(await fx.player());

      await postgres.query(
        "UPDATE servers SET reserved_by_match_id = $2::uuid WHERE id = $1::uuid",
        [id, matchId],
      );

      expect(await makeService()["freePracticeServer"]("TestA")).toBeNull();
    });
  });

  describe("claims and releases", () => {
    it("frees a server whose session is over", async () => {
      const id = await practiceServer();
      const host = await fx.player();
      const matchId = await someMatch(host);
      await claim(id, matchId);
      await session(host, matchId, "Ended");

      expect(await makeService().releaseOrphanedServers()).toBe(1);
      expect(await heldBy(id)).toBeNull();
    });

    it("frees a server whose session never linked a match", async () => {
      const id = await practiceServer();
      const matchId = await someMatch(await fx.player());
      await claim(id, matchId);

      expect(await makeService().releaseOrphanedServers()).toBe(1);
      expect(await heldBy(id)).toBeNull();
    });

    it("leaves a server held by a live session alone", async () => {
      const id = await practiceServer();
      const host = await fx.player();
      const matchId = await someMatch(host);
      await claim(id, matchId);
      await session(host, matchId, "Ready");

      expect(await makeService().releaseOrphanedServers()).toBe(0);
      expect(await heldBy(id)).toBe(matchId);
    });

    it("never touches a reserved server that is not a practice server", async () => {
      const [ranked] = await postgres.query<Array<{ id: string }>>(
        "SELECT id::text AS id FROM servers WHERE type = 'Ranked' LIMIT 1",
      );
      const matchId = await someMatch(await fx.player());
      await claim(ranked.id, matchId);

      expect(await makeService().releaseOrphanedServers()).toBe(0);
      expect(await heldBy(ranked.id)).toBe(matchId);
    });
  });

  describe("who holds what", () => {
    it("lists a busy server, named by its holder", async () => {
      const id = await practiceServer();
      const host = await fx.player("Holder");
      const matchId = await someMatch(host);
      await claim(id, matchId);
      await session(host, matchId, "Ready");

      const [row] = await makeService().practiceServers({
        steam_id: host,
        role: "user",
      } as never);

      expect(row.id).toBe(id);
      expect(row.in_use).toBe(true);
      expect(row.held_by).toBe("Holder");
    });

    it("reports a free server as free, with no holder", async () => {
      const id = await practiceServer();

      const [row] = await makeService().practiceServers({
        steam_id: await fx.player(),
        role: "user",
      } as never);

      expect(row.id).toBe(id);
      expect(row.in_use).toBe(false);
      expect(row.held_by).toBeNull();
    });
  });

  async function claim(serverId: string, matchId: string): Promise<void> {
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = $2::uuid WHERE id = $1::uuid",
      [serverId, matchId],
    );
  }

  async function heldBy(serverId: string): Promise<string | null> {
    const [row] = await postgres.query<
      Array<{ reserved_by_match_id: string | null }>
    >(
      "SELECT reserved_by_match_id::text FROM servers WHERE id = $1::uuid",
      [serverId],
    );
    return row.reserved_by_match_id;
  }

  async function session(
    hostSteamId: string,
    matchId: string,
    status: string,
  ): Promise<void> {
    await postgres.query(
      `INSERT INTO utility_practice_sessions
         (host_steam_id, map_name, region, status, match_id)
       VALUES ($1, 'de_mirage', 'TestA', $3, $2::uuid)`,
      [hostSteamId, matchId, status],
    );
  }

  async function availableInRegion(region: string): Promise<number> {
    const [row] = await postgres.query<Array<{ count: string }>>(
      `SELECT available_region_server_count(sr.*) AS count
         FROM server_regions sr WHERE sr.value = $1`,
      [region],
    );
    return Number(row.count);
  }

  async function someMatch(hostSteamId: string): Promise<string> {
    const [map] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM maps WHERE type = 'Competitive' AND name = 'de_mirage' LIMIT 1",
    );
    const [pool] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO map_pools (type) VALUES ('Custom') RETURNING id",
    );
    await postgres.query(
      "INSERT INTO _map_pool (map_pool_id, map_id) VALUES ($1, $2)",
      [pool.id, map.id],
    );
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options
         (type, best_of, map_veto, map_pool_id, region_veto, regions, mr, tv_delay)
       VALUES ('Competitive', 1, false, $1, false, ARRAY['TestA'], 12, 0)
       RETURNING id`,
      [pool.id],
    );
    const [match] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO matches (match_options_id, organizer_steam_id, region, source, label)
       VALUES ($1, $2, 'TestA', 'practice', 'Utility Practice')
       RETURNING id`,
      [options.id, hostSteamId],
    );
    return match.id;
  }
});
