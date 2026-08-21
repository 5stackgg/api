import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityPlaybooksService } from "./../src/utility/utility-playbooks.service";
import { UtilityPracticeService } from "./../src/utility/utility-practice.service";
import { UtilityLoadService } from "./../src/utility/utility-load.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A practice session is a real match, so the things that can go wrong are the
// things that go wrong with matches: two sessions racing for one host, a
// session taking the last free server from a scheduled match, a session that
// outlives the people in it, and -- the one the plugin actually cares about --
// a mid-session join whose lineup row lands after the roster refresh, which
// gets the invited player rejected at connect.
describe("utility practice sessions (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let notified: Array<{
    type: string;
    entity_id?: string;
    steamIds: Array<string>;
    message: string;
    actions?: Array<{ label: string }>;
  }>;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityPracticeTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199800000000n);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    notified = [];
    await postgres.query("DELETE FROM utility_practice_sessions");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query(
      "UPDATE servers SET reserved_by_match_id = NULL WHERE reserved_by_match_id IS NOT NULL",
    );
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM servers WHERE port >= 27960");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "DELETE FROM settings WHERE name LIKE 'public.utility_%'",
    );
  });

  async function setting(name: string, value: string) {
    await postgres.query(
      `INSERT INTO settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [name, value],
    );
  }

  async function insertSession(
    host: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      host_steam_id: host,
      map_name: "de_mirage",
      region: "TestA",
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_practice_sessions (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
       RETURNING id::text AS id`,
      Object.values(row) as Array<string>,
    );
    return inserted.id;
  }

  // The exact shape startUtilityPractice builds: a one-map Custom pool, no veto,
  // Competitive with enough substitutes for a full practice server, and
  // source='practice' so match_events takes the practice branch.
  async function createPracticeMatch(host: string): Promise<{
    matchId: string;
    optionsId: string;
    poolId: string;
    lineupId: string;
  }> {
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
         (type, best_of, map_veto, map_pool_id, region_veto, regions,
          number_of_substitutes, knife_round, overtime, mr, tv_delay)
       VALUES ('Competitive', 1, false, $1, false, ARRAY['TestA'], $2,
               false, false, 12, 0)
       RETURNING id`,
      [pool.id, UtilityPracticeService.SUBSTITUTES],
    );
    const [match] = await postgres.query<
      Array<{ id: string; lineup_1_id: string }>
    >(
      `INSERT INTO matches (match_options_id, organizer_steam_id, region, source, label)
       VALUES ($1, $2, 'TestA', 'practice', 'Utility Practice')
       RETURNING id, lineup_1_id`,
      [options.id, host],
    );
    await postgres.query(
      "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)",
      [match.lineup_1_id, host],
    );

    return {
      matchId: match.id,
      optionsId: options.id,
      poolId: pool.id,
      lineupId: match.lineup_1_id,
    };
  }

  function makeService(overrides: {
    matchAssistant?: Record<string, unknown>;
    cache?: Record<string, unknown>;
  }): UtilityPracticeService {
    return new UtilityPracticeService(
      new Logger("UtilityPracticeTest"),
      postgres,
      {} as never,
      {
        acquireLock: jest.fn(async (): Promise<boolean> => true),
        forget: jest.fn(async (): Promise<boolean> => true),
        get: jest.fn(async (_key: string, fallback: unknown) => fallback),
        put: jest.fn(async (): Promise<void> => undefined),
        ...(overrides.cache ?? {}),
      } as unknown as never,
      {
        countFreeOnDemandServers: jest.fn(async (): Promise<number> => 10),
        sendUtilityPracticeRefresh: jest.fn(async (): Promise<void> => undefined),
        updateMatchStatus: jest.fn(async (): Promise<void> => undefined),
        ...(overrides.matchAssistant ?? {}),
      } as unknown as never,
      new UtilityPlaybooksService(postgres),
      {
        notifyPlayers: jest.fn(
          async (
            type: string,
            notification: {
              entity_id?: string;
              steamIds: Array<string>;
              message: string;
            },
            actions?: Array<{ label: string }>,
          ): Promise<number> => {
            notified.push({ type, ...notification, actions });
            return notification.steamIds.length;
          },
        ),
      } as unknown as never,
      {
        get: jest.fn(() => ({ webDomain: "https://5stack.test" })),
      } as unknown as never,
    );
  }

  describe("one live session per host", () => {
    // The service checks too, but the check races with a double-clicked
    // button. This index is the guard that cannot.
    it("refuses a second Starting session for the same host", async () => {
      const host = await fx.player();
      await insertSession(host);

      await expect(insertSession(host)).rejects.toThrow(/one_live_per_host/);
    });

    it("refuses a Starting session while an earlier one is Ready", async () => {
      const host = await fx.player();
      const first = await insertSession(host);
      await postgres.query(
        "UPDATE utility_practice_sessions SET status = 'Ready' WHERE id = $1",
        [first],
      );

      await expect(insertSession(host)).rejects.toThrow(/one_live_per_host/);
    });

    it("frees the host once the session reaches a terminal status", async () => {
      const host = await fx.player();
      const first = await insertSession(host);
      await postgres.query(
        "UPDATE utility_practice_sessions SET status = 'Ended' WHERE id = $1",
        [first],
      );

      await expect(insertSession(host)).resolves.toBeTruthy();
    });

    it("lets two different hosts each hold one", async () => {
      const a = await fx.player();
      const b = await fx.player();

      await expect(insertSession(a)).resolves.toBeTruthy();
      await expect(insertSession(b)).resolves.toBeTruthy();
    });
  });

  describe("server headroom", () => {
    it("refuses to start when only the reserved servers are free", async () => {
      const host = await fx.player();
      await setting("public.utility_practice_enabled", "true");
      await setting("public.utility_practice_reserved_servers", "2");

      const service = makeService({
        matchAssistant: {
          countFreeOnDemandServers: jest.fn(async (): Promise<number> => 2),
        },
      });

      await expect(
        service.start({ steam_id: host, role: "user" } as never, {
          map_name: "de_mirage",
          region: "TestA",
        }),
      ).rejects.toThrow(/no practice servers are free/);

      const rows = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM utility_practice_sessions",
      );
      expect(rows.length).toBe(0);
    });

    it("refuses to start at all while the feature is off", async () => {
      const host = await fx.player();
      await setting("public.utility_practice_enabled", "false");

      const service = makeService({});

      await expect(
        service.start({ steam_id: host, role: "user" } as never, {
          map_name: "de_mirage",
          region: "TestA",
        }),
      ).rejects.toThrow(/not enabled/);
    });
  });

  describe("the practice match", () => {
    it("materializes exactly one match map from a one-map Custom pool", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM match_maps WHERE match_id = $1",
        [matchId],
      );
      expect(Number(count)).toBe(1);
    });

    // check_match_status refuses Live unless match_map_count == best_of, and
    // get_match_type_min_players would raise on an invented 'Practice' type --
    // Competitive plus one map is what satisfies both with a single player.
    it("reaches Live with a single player in the lineup", async () => {
      const host = await fx.player();
      const { matchId, lineupId } = await createPracticeMatch(host);

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM match_lineup_players WHERE match_lineup_id = $1",
        [lineupId],
      );
      expect(Number(count)).toBe(1);

      await expect(
        postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
          matchId,
        ]),
      ).resolves.toBeTruthy();

      const [match] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM matches WHERE id = $1",
        [matchId],
      );
      expect(match.status).toBe("Live");
    });

    it("leaves room for nine more players in the lineup", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);

      const [row] = await postgres.query<Array<{ max: number }>>(
        "SELECT match_max_players_per_lineup(m) AS max FROM matches m WHERE m.id = $1",
        [matchId],
      );
      expect(Number(row.max)).toBe(10);
    });

    it("cleans up its Custom pool once nothing references it", async () => {
      const host = await fx.player();
      const { matchId, optionsId, poolId } = await createPracticeMatch(host);

      await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);
      await postgres.query("DELETE FROM match_options WHERE id = $1", [
        optionsId,
      ]);

      const pools = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM map_pools WHERE id = $1",
        [poolId],
      );
      expect(pools.length).toBe(0);
    });

    it("keeps the session row when the match is swept away", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, { match_id: matchId });

      await postgres.query("DELETE FROM matches WHERE id = $1", [matchId]);

      const [session] = await postgres.query<
        Array<{ id: string; match_id: string | null }>
      >(
        "SELECT id::text AS id, match_id::text AS match_id FROM utility_practice_sessions WHERE id = $1",
        [sessionId],
      );
      expect(session.id).toBe(sessionId);
      expect(session.match_id).toBeNull();
    });
  });

  describe("joining", () => {
    async function liveSession(
      overrides: Record<string, unknown> = {},
    ): Promise<{ host: string; matchId: string; sessionId: string }> {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
        ...overrides,
      });
      return { host, matchId, sessionId };
    }

    async function lineupCount(matchId: string): Promise<number> {
      const [row] = await postgres.query<Array<{ count: string }>>(
        `SELECT COUNT(*) AS count
           FROM match_lineup_players mlp
           INNER JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
          WHERE ml.match_id = $1`,
        [matchId],
      );
      return Number(row.count);
    }

    // The practice plugin caches its roster. A player invited mid-session is
    // not in that cache, so a link handed back before the utility_practice_refresh
    // RCON lands gets them rejected at connect. Asserting the row count *from
    // inside* the refresh is what pins the ordering, not just that both
    // happened.
    it("adds the lineup row and only then refreshes the server roster", async () => {
      const { matchId, sessionId } = await liveSession({ is_open: true });
      const guest = await fx.player();

      let lineupAtRefresh = -1;
      const sendUtilityPracticeRefresh = jest.fn(
        async (id: string): Promise<void> => {
          lineupAtRefresh = await lineupCount(id);
        },
      );

      const service = makeService({
        matchAssistant: { sendUtilityPracticeRefresh },
      });

      await expect(
        service.join({ steam_id: guest, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).resolves.toEqual({ session_id: sessionId, match_id: matchId });

      expect(sendUtilityPracticeRefresh).toHaveBeenCalledWith(matchId);
      expect(lineupAtRefresh).toBe(2);
      expect(await lineupCount(matchId)).toBe(2);
    });

    // An invite code is a bearer credential, so the lookup is the enumeration
    // surface. Without this the only thing standing between a stranger and
    // someone's practice server is the width of the code.
    it("rate limits repeated invite code lookups by the caller", async () => {
      const counts = new Map<string, number>();
      const service = makeService({
        cache: {
          get: jest.fn(async (key: string, fallback: unknown) =>
            counts.has(key) ? counts.get(key) : fallback,
          ),
          put: jest.fn(async (key: string, value: unknown) => {
            counts.set(key, Number(value));
          }),
        },
      });
      const guest = await fx.player();

      for (let attempt = 0; attempt < 10; attempt++) {
        await expect(
          service.join({ steam_id: guest, role: "user" } as never, {
            invite_code: "ZZZZZZZZZZ",
          }),
        ).rejects.toThrow(/not found/i);
      }

      await expect(
        service.join({ steam_id: guest, role: "user" } as never, {
          invite_code: "ZZZZZZZZZZ",
        }),
      ).rejects.toThrow(/too many invite attempts/i);
    });

    it("resolves a session by its invite code", async () => {
      const { matchId, sessionId } = await liveSession({ is_open: true });
      const guest = await fx.player();
      const [row] = await postgres.query<Array<{ invite_code: string }>>(
        "SELECT invite_code FROM utility_practice_sessions WHERE id = $1",
        [sessionId],
      );

      const service = makeService({});

      await expect(
        service.join({ steam_id: guest, role: "user" } as never, {
          invite_code: row.invite_code,
        }),
      ).resolves.toEqual({ session_id: sessionId, match_id: matchId });
    });

    it("refuses a stranger when the session is closed", async () => {
      const { matchId, sessionId } = await liveSession();
      const stranger = await fx.player();

      const service = makeService({});

      await expect(
        service.join({ steam_id: stranger, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).rejects.toThrow(/not invited/);

      expect(await lineupCount(matchId)).toBe(1);
    });

    it("lets an invited player into a closed session", async () => {
      const { host, matchId, sessionId } = await liveSession();
      const invited = await fx.player();

      await postgres.query(
        `INSERT INTO utility_practice_invites
           (utility_practice_session_id, steam_id, invited_by_steam_id)
         VALUES ($1, $2, $3)`,
        [sessionId, invited, host],
      );

      const service = makeService({});

      await expect(
        service.join({ steam_id: invited, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).resolves.toBeTruthy();

      expect(await lineupCount(matchId)).toBe(2);
    });

    it("lets an accepted friend of the host in", async () => {
      const { host, matchId, sessionId } = await liveSession();
      const friend = await fx.player();

      await postgres.query(
        `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
         VALUES ($1, $2, 'Accepted')`,
        [host, friend],
      );

      const service = makeService({});

      await expect(
        service.join({ steam_id: friend, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).resolves.toBeTruthy();

      expect(await lineupCount(matchId)).toBe(2);
    });

    it("refuses once the lineup is at max_players_per_lineup", async () => {
      const { matchId, sessionId, host } = await liveSession({
        is_open: true,
      });
      const [match] = await postgres.query<Array<{ lineup_1_id: string }>>(
        "SELECT lineup_1_id FROM matches WHERE id = $1",
        [matchId],
      );

      for (let i = 0; i < 9; i++) {
        await fx.lineupPlayer(match.lineup_1_id);
      }
      expect(await lineupCount(matchId)).toBe(10);
      expect(host).toBeTruthy();

      const late = await fx.player();
      const sendUtilityPracticeRefresh = jest.fn(
        async (): Promise<void> => undefined,
      );
      const service = makeService({
        matchAssistant: { sendUtilityPracticeRefresh },
      });

      await expect(
        service.join({ steam_id: late, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).rejects.toThrow(/full/);

      expect(sendUtilityPracticeRefresh).not.toHaveBeenCalled();
      expect(await lineupCount(matchId)).toBe(10);
    });

    it("is a no-op for someone already in the lineup", async () => {
      const { host, matchId, sessionId } = await liveSession({
        is_open: true,
      });

      const service = makeService({});

      await expect(
        service.join({ steam_id: host, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).resolves.toEqual({ session_id: sessionId, match_id: matchId });

      expect(await lineupCount(matchId)).toBe(1);
    });

    it("refuses to join a session that is over", async () => {
      const { sessionId } = await liveSession({ is_open: true });
      await postgres.query(
        "UPDATE utility_practice_sessions SET status = 'Ended' WHERE id = $1",
        [sessionId],
      );
      const guest = await fx.player();

      const service = makeService({});

      await expect(
        service.join({ steam_id: guest, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).rejects.toThrow(/over/);
    });
  });

  describe("leaving", () => {
    // tbid_match_lineup_players refuses a removal that drops a Live lineup
    // below the Competitive minimum of five unless the session says admin --
    // which is every removal in a practice session.
    it("removes a guest from a Live practice lineup", async () => {
      const host = await fx.player();
      const { matchId, lineupId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });
      const guest = await fx.lineupPlayer(lineupId);
      await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
        matchId,
      ]);

      const service = makeService({});

      await expect(
        service.leave({ steam_id: guest, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).resolves.toEqual({ success: true });

      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        "SELECT COUNT(*) AS count FROM match_lineup_players WHERE match_lineup_id = $1",
        [lineupId],
      );
      expect(Number(count)).toBe(1);
    });

    it("tells the host to stop the session instead", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });

      const service = makeService({});

      await expect(
        service.leave({ steam_id: host, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).rejects.toThrow(/stopping the session/);
    });
  });

  // The reverse of reportOccupancy. That writes is_connected per player for the
  // session's match; this reads the same column backwards to answer "which
  // server is this player standing in", which is the whole basis of offering
  // "load me in" instead of the booking dialog. It joins five tables, so it is
  // asserted against real SQL rather than trusted.
  describe("finding the server a player is standing in", () => {
    function loadService(): UtilityLoadService {
      // serverForPlayer touches postgres only; cache and rcon belong to the
      // send path, which is not what is under test here.
      return new UtilityLoadService(
        new Logger(),
        postgres,
        null as never,
        null as never,
      );
    }

    async function occupiedServer(
      host: string,
      label: string,
      port: number,
      overrides: Record<string, unknown> = {},
    ): Promise<{ serverId: string; sessionId: string; lineupId: string }> {
      const { matchId, lineupId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
        ...overrides,
      });
      const [server] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers
           (host, label, rcon_password, port, region, type, is_dedicated, enabled,
            reserved_by_match_id)
         VALUES ('127.0.0.1', $1, '\\x00'::bytea, $2, 'TestA', 'Ranked', true, true, $3)
         RETURNING id::text AS id`,
        [label, port, matchId],
      );
      return { serverId: server.id, sessionId, lineupId };
    }

    // Exactly what reportOccupancy does: the host is already on the lineup, so
    // arriving is a flag flip rather than a new row.
    async function connect(lineupId: string, steamId: string) {
      await postgres.query(
        `UPDATE match_lineup_players
            SET is_connected = true
          WHERE match_lineup_id = $1::uuid
            AND steam_id = $2::bigint`,
        [lineupId, steamId],
      );
    }

    it("finds the server a connected player is on", async () => {
      const host = await fx.player();
      const { serverId, sessionId, lineupId } = await occupiedServer(
        host,
        "occupied-a",
        27600,
      );
      await connect(lineupId, host);

      const at = await loadService().serverForPlayer(host);

      expect(at).toMatchObject({
        server_id: serverId,
        session_id: sessionId,
        map_name: "de_mirage",
      });
    });

    // The column is what occupancy actually maintains, so a player who has left
    // has to stop resolving -- otherwise the panel keeps RCONing a server the
    // player walked out of.
    it("ignores a player who is no longer connected", async () => {
      const host = await fx.player();
      const { lineupId } = await occupiedServer(host, "occupied-b", 27601);
      await connect(lineupId, host);
      await postgres.query(
        "UPDATE match_lineup_players SET is_connected = false WHERE steam_id = $1::bigint",
        [host],
      );

      expect(await loadService().serverForPlayer(host)).toBeNull();
    });

    // A session that has ended still has its rows; loading onto a server that
    // is no longer running practice would be sending a command into a match.
    it("ignores a session that is no longer live", async () => {
      const host = await fx.player();
      const { lineupId, sessionId } = await occupiedServer(
        host,
        "occupied-c",
        27602,
      );
      await connect(lineupId, host);
      await postgres.query(
        "UPDATE utility_practice_sessions SET status = 'Ended' WHERE id = $1",
        [sessionId],
      );

      expect(await loadService().serverForPlayer(host)).toBeNull();
    });

    it("answers null for somebody who is on no server at all", async () => {
      expect(await loadService().serverForPlayer(await fx.player())).toBeNull();
    });
  });

  describe("the server's own session", () => {
    async function reservedServer(
      label: string,
      matchId: string,
      port: number,
    ): Promise<string> {
      const [server] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers
           (host, label, rcon_password, port, region, type, is_dedicated, enabled,
            reserved_by_match_id)
         VALUES ('127.0.0.1', $1, '\\x00'::bytea, $2, 'TestA', 'Ranked', true, true, $3)
         RETURNING id::text AS id`,
        [label, port, matchId],
      );
      return server.id;
    }

    it("returns the roster, map and password for the server's own session", async () => {
      const host = await fx.player();
      const { matchId, lineupId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });
      const mate = await fx.lineupPlayer(lineupId);
      const serverId = await reservedServer("practice-a", matchId, 27960);

      const service = makeService({});
      const session = await service.sessionForServer(serverId);

      expect(session?.session_id).toBe(sessionId);
      expect(session?.match_id).toBe(matchId);
      expect(session?.map_name).toBe("de_mirage");
      expect(session?.password).toBeTruthy();
      expect(session?.steam_ids.sort()).toEqual([host, mate].sort());
    });

    // A compromised game server that could name a session id could read another
    // session's match password, which is the credential for walking onto that
    // server. The lookup starts from the authenticated server for that reason.
    it("never reaches a session running on a different server", async () => {
      const hostA = await fx.player();
      const hostB = await fx.player();
      const a = await createPracticeMatch(hostA);
      const b = await createPracticeMatch(hostB);
      await insertSession(hostA, { match_id: a.matchId, status: "Ready" });
      const sessionB = await insertSession(hostB, {
        match_id: b.matchId,
        status: "Ready",
      });

      const serverA = await reservedServer("practice-a", a.matchId, 27961);

      const service = makeService({});
      const session = await service.sessionForServer(serverA);

      expect(session?.match_id).toBe(a.matchId);
      expect(session?.session_id).not.toBe(sessionB);
    });

    it("returns nothing for a server that is not running a practice session", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      await insertSession(host, { match_id: matchId, status: "Ready" });

      const [idle] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO servers
           (host, label, rcon_password, port, region, type, is_dedicated, enabled)
         VALUES ('127.0.0.1', 'idle', '\\x00'::bytea, 27962, 'TestA', 'Ranked', true, true)
         RETURNING id::text AS id`,
      );

      const service = makeService({});
      expect(await service.sessionForServer(idle.id)).toBeNull();
    });

    it("returns nothing once the session is over", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });
      const serverId = await reservedServer("practice-a", matchId, 27963);
      await postgres.query(
        "UPDATE utility_practice_sessions SET status = 'Ended' WHERE id = $1",
        [sessionId],
      );

      const service = makeService({});
      expect(await service.sessionForServer(serverId)).toBeNull();
    });
  });

  describe("the reaper", () => {
    function serviceWithRealCancel() {
      const updateMatchStatus = jest.fn(
        async (matchId: string, status: string): Promise<void> => {
          await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
            matchId,
            status,
          ]);
        },
      );
      return {
        updateMatchStatus,
        service: makeService({ matchAssistant: { updateMatchStatus } }),
      };
    }

    // The idle clock only exists once somebody has been in the server. Before
    // that a session is governed by the connect grace instead, so these two
    // have to say a player was there and left.
    async function joined(sessionId: string): Promise<void> {
      await postgres.query(
        "UPDATE utility_practice_sessions SET first_joined_at = now() - interval '1 hour' WHERE id = $1",
        [sessionId],
      );
    }

    it("marks an empty session's clock and leaves it alone until it is stale", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });
      await setting("public.utility_practice_idle_minutes", "10");
      await joined(sessionId);

      const { service } = serviceWithRealCancel();
      expect(await service.reapIdle()).toBe(0);

      const [row] = await postgres.query<
        Array<{ empty_since: Date | null; status: string }>
      >(
        "SELECT empty_since, status FROM utility_practice_sessions WHERE id = $1",
        [sessionId],
      );
      expect(row.empty_since).not.toBeNull();
      expect(row.status).toBe("Ready");
    });

    it("ends a session that has been empty past the idle window", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });
      await setting("public.utility_practice_idle_minutes", "10");
      await joined(sessionId);
      await postgres.query(
        "UPDATE utility_practice_sessions SET empty_since = now() - interval '30 minutes' WHERE id = $1",
        [sessionId],
      );

      const { service, updateMatchStatus } = serviceWithRealCancel();
      expect(await service.reapIdle()).toBe(1);

      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM utility_practice_sessions WHERE id = $1",
        [sessionId],
      );
      expect(row.status).toBe("Ended");
      expect(updateMatchStatus).toHaveBeenCalledWith(matchId, "Canceled");

      const [match] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM matches WHERE id = $1",
        [matchId],
      );
      expect(match.status).toBe("Canceled");
    });

    // Occupancy is the thing that resets the clock, and the trigger is what
    // guarantees it -- an update that touches last_occupied_at clears
    // empty_since whether or not the caller remembered to.
    it("resets the idle clock while someone is connected", async () => {
      const host = await fx.player();
      const { matchId, lineupId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });
      await postgres.query(
        "UPDATE utility_practice_sessions SET empty_since = now() - interval '30 minutes' WHERE id = $1",
        [sessionId],
      );
      await postgres.query(
        "UPDATE match_lineup_players SET is_connected = true WHERE match_lineup_id = $1",
        [lineupId],
      );

      const { service } = serviceWithRealCancel();
      expect(await service.reapIdle()).toBe(0);

      const [row] = await postgres.query<
        Array<{ status: string; empty_since: Date | null }>
      >(
        "SELECT status, empty_since FROM utility_practice_sessions WHERE id = $1",
        [sessionId],
      );
      expect(row.status).toBe("Ready");
      expect(row.empty_since).toBeNull();
    });

    it("fails a session that never left Starting", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, { match_id: matchId });
      await postgres.query(
        "UPDATE utility_practice_sessions SET created_at = now() - interval '1 hour' WHERE id = $1",
        [sessionId],
      );

      const { service } = serviceWithRealCancel();
      expect(await service.reapIdle()).toBe(1);

      const [row] = await postgres.query<
        Array<{ status: string; expires_at: Date | null }>
      >("SELECT status, expires_at FROM utility_practice_sessions WHERE id = $1", [
        sessionId,
      ]);
      expect(row.status).toBe("Failed");
      expect(row.expires_at).not.toBeNull();
    });
  });

  describe("access and connection fields", () => {
    const session = (steamId: string | null, role = "user") =>
      JSON.stringify({
        "x-hasura-role": role,
        ...(steamId ? { "x-hasura-user-id": steamId } : {}),
      });

    async function canView(
      sessionId: string,
      viewer: string | null,
      role = "user",
    ) {
      const [row] = await postgres.query<Array<{ ok: boolean }>>(
        `SELECT can_view_utility_practice_session(s, $2::json) AS ok
           FROM utility_practice_sessions s WHERE s.id = $1`,
        [sessionId, session(viewer, role)],
      );
      return row.ok;
    }

    it("keeps a closed session to its host, its invitees and its team", async () => {
      const team = await fx.team(1);
      const [mate] = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id FROM team_roster
          WHERE team_id = $1 AND player_steam_id <> $2 LIMIT 1`,
        [team.id, team.owner],
      );
      const stranger = await fx.player();
      const invited = await fx.player();
      const sessionId = await insertSession(team.owner, { team_id: team.id });
      await postgres.query(
        `INSERT INTO utility_practice_invites
           (utility_practice_session_id, steam_id, invited_by_steam_id)
         VALUES ($1, $2, $3)`,
        [sessionId, invited, team.owner],
      );

      expect(await canView(sessionId, team.owner)).toBe(true);
      expect(await canView(sessionId, mate.player_steam_id)).toBe(true);
      expect(await canView(sessionId, invited)).toBe(true);
      expect(await canView(sessionId, stranger)).toBe(false);
      expect(await canView(sessionId, null, "guest")).toBe(false);
    });

    it("shows an open session to any signed-in player but not a guest", async () => {
      const host = await fx.player();
      const stranger = await fx.player();
      const sessionId = await insertSession(host, { is_open: true });

      expect(await canView(sessionId, stranger)).toBe(true);
      expect(await canView(sessionId, null, "guest")).toBe(false);
    });

    // The link only exists for someone the match considers in the lineup, which
    // is exactly what joinUtilityPractice creates -- so a session with no match
    // yet, or a viewer who has not joined, has nothing to connect to.
    it("returns no connection link before there is a match", async () => {
      const host = await fx.player();
      const sessionId = await insertSession(host);

      const [row] = await postgres.query<
        Array<{ link: string | null; connect: string | null }>
      >(
        `SELECT utility_practice_connection_link(s, $2::json) AS link,
                utility_practice_connection_string(s, $2::json) AS connect
           FROM utility_practice_sessions s WHERE s.id = $1`,
        [sessionId, session(host)],
      );
      expect(row.link).toBeNull();
      expect(row.connect).toBeNull();
    });

    it("reports lineup membership through is_utility_practice_member", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, { match_id: matchId });
      const stranger = await fx.player();

      const member = async (steamId: string) => {
        const [row] = await postgres.query<Array<{ ok: boolean }>>(
          `SELECT is_utility_practice_member(s, $2::json) AS ok
             FROM utility_practice_sessions s WHERE s.id = $1`,
          [sessionId, session(steamId)],
        );
        return row.ok;
      };

      expect(await member(host)).toBe(true);
      expect(await member(stranger)).toBe(false);
    });
  });

  describe("map validation", () => {
    it("refuses a session on a map that does not exist", async () => {
      const host = await fx.player();
      await expect(
        insertSession(host, { map_name: "de_notamap" }),
      ).rejects.toThrow(/Unknown map/);
    });
  });

  // Before this the invite wrote a row and told nobody, which made "invite a
  // friend" a feature you had to describe out loud over voice comms.
  describe("telling people", () => {
    it("notifies the players an invite actually reached", async () => {
      const host = await fx.player("Captain");
      const invited = await fx.player();
      const sessionId = await insertSession(host, { status: "Ready" });

      await makeService({}).invite({ steam_id: host } as never, {
        session_id: sessionId,
        steam_ids: [invited, "76561199000000001"],
      });

      expect(notified).toHaveLength(1);
      expect(notified[0].type).toBe("UtilityPracticeInvite");
      // The unknown steam id never got an invite row, so it never gets told.
      expect(notified[0].steamIds).toEqual([invited]);
      expect(notified[0].entity_id).toBe(sessionId);
      expect(notified[0].message).toContain("Captain");
      // The map board with the invite code on it: a session is a dialog the
      // board opens, not a page, and the code is what joinUtilityPractice takes.
      const [{ invite_code }] = await postgres.query<
        Array<{ invite_code: string }>
      >("SELECT invite_code FROM utility_practice_sessions WHERE id = $1", [
        sessionId,
      ]);
      expect(notified[0].message).toContain(
        `https://5stack.test/utility/de_mirage?practice=${invite_code}`,
      );
      // Joining from the bell is the whole point of the notification.
      expect(notified[0].actions?.[0].label).toBe("Join");
    });

    it("does not buzz a player who was already invited", async () => {
      const host = await fx.player();
      const invited = await fx.player();
      const sessionId = await insertSession(host, { status: "Ready" });
      const service = makeService({});

      await service.invite({ steam_id: host } as never, {
        session_id: sessionId,
        steam_ids: [invited],
      });
      await service.invite({ steam_id: host } as never, {
        session_id: sessionId,
        steam_ids: [invited],
      });

      expect(notified).toHaveLength(1);
    });

    // The plugin polls GET /utility/session, so markReady runs over and over.
    // Only the poll that moved the session out of Starting may announce it.
    it("announces a ready server once, to the host and the lineup", async () => {
      const host = await fx.player();
      const { matchId, lineupId } = await createPracticeMatch(host);
      const mate = await fx.player();
      await postgres.query(
        "INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)",
        [lineupId, mate],
      );
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Starting",
      });
      const service = makeService({});

      await service.markReady(matchId);
      await service.markReady(matchId);

      expect(notified).toHaveLength(1);
      expect(notified[0].type).toBe("UtilityPracticeReady");
      expect(notified[0].steamIds.sort()).toEqual([host, mate].sort());
      // Suffixed so the bell does not stack it onto the invite for the same
      // session.
      expect(notified[0].entity_id).toBe(`${sessionId}:ready`);
      // No deeper target exists; the host already holds the dialog.
      expect(notified[0].message).toContain(
        "https://5stack.test/utility/de_mirage",
      );
    });
  });
});
