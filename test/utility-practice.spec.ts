import { Logger } from "@nestjs/common";
import { readFileSync } from "fs";
import * as yaml from "js-yaml";
import { join } from "path";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityPlaybooksService } from "./../src/utility/utility-playbooks.service";
import { UtilityPracticeService } from "./../src/utility/utility-practice.service";
import { UtilityLoadService } from "./../src/utility/utility-load.service";
import { Fixtures } from "./utils/fixtures";
import { HasuraPermissions } from "./utils/hasura-permissions";
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
    rconSent = [];
    rconReply = () => "";
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

  async function befriend(a: string, b: string, status = "Accepted") {
    await postgres.query(
      `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
       VALUES ($1, $2, $3)`,
      [a, b, status],
    );
  }

  // A dedicated practice box: already running, already listed in the picker,
  // and the thing an on-demand choice must not be quietly answered with.
  async function standingPracticeServer(region: string): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, enabled, connected, region, type, is_dedicated)
       VALUES ('127.0.0.1', $1, $2, 27960, true, true, $3, 'Practice', true)
       RETURNING id::text AS id`,
      [`practice-${region}`, Buffer.from("password"), region],
    );
    return row.id;
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

  /**
   * Enough of a lineup for the visibility function to have an opinion.
   * Deliberately Private: an author can always see their own, and Public is
   * refused on insert by the review trigger.
   */
  async function insertLineup(
    author: string,
    mapName: string,
  ): Promise<string> {
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_lineups
         (map_name, utility_type, side, technique, throw_strength,
          origin_x, origin_y, origin_z, view_yaw, view_pitch,
          land_x, land_y, land_z,
          name, visibility, author_steam_id)
       VALUES ($1, 'Smoke', 'TERRORIST', 'Jump', 'Full',
               -1912, 922, -167, 133.7, -12.4,
               -560, 320, -140,
               'Window from T spawn', 'Private', $2::bigint)
       RETURNING id::text AS id`,
      [mapName, author],
    );
    return inserted.id;
  }

  // Every command the fake RCON connection was handed, in order. A map change
  // is only observable from here -- the DB says where the server is meant to be,
  // and this says whether anything was ever told.
  let rconSent: Array<{ serverId: string; command: string }>;
  let rconReply: (command: string) => string | null;

  /**
   * A real UtilityLoadService over the real database, with only the wire
   * stubbed. visibleOnMap and the pending-library writes are the half of a map
   * change that decides whether the caller may practise what they asked for, so
   * mocking them out would leave the interesting part untested.
   */
  function makeLoadService(): UtilityLoadService {
    const cache = new Map<string, unknown>();

    return new UtilityLoadService(
      new Logger("UtilityLoadTest"),
      postgres,
      {
        get: jest.fn(async (key: string) => cache.get(key)),
        put: jest.fn(async (key: string, value: unknown) => {
          cache.set(key, value);
        }),
      } as unknown as never,
      {
        connect: jest.fn(async (serverId: string) => ({
          send: jest.fn(async (command: string) => {
            const reply = rconReply(command);

            if (reply === null) {
              throw new Error("server unreachable");
            }

            rconSent.push({ serverId, command });
            return reply;
          }),
        })),
      } as unknown as never,
    );
  }

  // Counters the service keeps in redis rather than in the cache service --
  // the invite-lookup limit is an INCR, because a get-then-put cannot count
  // attempts that are in flight together.
  function redisStub() {
    const counters = new Map<string, number>();

    return {
      counters,
      connection: {
        publish: jest.fn(async (): Promise<number> => 0),
        multi: () => {
          const queued: Array<[string, unknown]> = [];
          const chain = {
            incr(key: string) {
              const next = (counters.get(key) ?? 0) + 1;
              counters.set(key, next);
              queued.push([key, next]);
              return chain;
            },
            expire() {
              return chain;
            },
            exec: async () => queued.map(([, value]) => [null, value]),
          };
          return chain;
        },
      },
    };
  }

  function makeService(overrides: {
    matchAssistant?: Record<string, unknown>;
    cache?: Record<string, unknown>;
    load?: UtilityLoadService;
    redis?: ReturnType<typeof redisStub>;
  }): UtilityPracticeService {
    const redis = overrides.redis ?? redisStub();

    return new UtilityPracticeService(
      new Logger("UtilityPracticeTest"),
      postgres,
      {} as never,
      {
        acquireLock: jest.fn(async (): Promise<string | null> => "token"),
        releaseLock: jest.fn(async (): Promise<boolean> => true),
        forget: jest.fn(async (): Promise<boolean> => true),
        get: jest.fn(async (_key: string, fallback: unknown) => fallback),
        put: jest.fn(async (): Promise<void> => undefined),
        ...(overrides.cache ?? {}),
      } as unknown as never,
      {
        countFreeOnDemandServers: jest.fn(async (): Promise<number> => 10),
        // An install that can boot pods, unless a test says otherwise: the
        // other answer is a different refusal, not a busier one.
        hasOnDemandNodes: jest.fn(async (): Promise<boolean> => true),
        practiceNodeIds: jest.fn(async (): Promise<string[]> => ["node-1"]),
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
      overrides.load ?? makeLoadService(),
      {
        ensureMode: jest.fn(async (): Promise<null> => null),
      } as unknown as never,
      {
        get: jest.fn(() => ({ webDomain: "https://5stack.test" })),
      } as unknown as never,
      {
        getConnection: () => redis.connection,
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
    // Two rules on one fixture, because a standing server in the named region
    // is what makes the refusal meaningful. The region group in the picker is
    // headed ON DEMAND, and every standing practice server is a row of its own
    // beside it: answering "US-EAST" with the box already running in US-EAST
    // handed back a server nobody asked for -- and when that box is not really
    // up, one that never answers, behind a connect string that made the website
    // say "ready to join".
    it("refuses a named region on reserved headroom without taking the standing server", async () => {
      const host = await fx.player();
      await setting("public.utility_practice_enabled", "true");
      await setting("public.utility_practice_reserved_servers", "2");
      await standingPracticeServer("TestA");

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

      const [server] = await postgres.query<Array<{ reserved: string | null }>>(
        `SELECT reserved_by_match_id::text AS reserved
           FROM servers WHERE type = 'Practice'`,
      );
      expect(server.reserved).toBeNull();
    });

    // The other half of the same rule: automatic is the choice whose own hint
    // promises "a free practice server if one is standing", so it takes one and
    // never spends a slot the headroom is holding back.
    it("still takes a standing server for the automatic choice", async () => {
      const host = await fx.player();
      await setting("public.utility_practice_enabled", "true");
      await setting("public.utility_practice_reserved_servers", "2");
      await standingPracticeServer("TestA");

      const service = makeService({
        matchAssistant: {
          countFreeOnDemandServers: jest.fn(async (): Promise<number> => 2),
        },
      });

      // The match behind it needs hasura, which this suite does not stand up --
      // so it gets as far as the session row and no further. That row is the
      // whole assertion: a start turned away by the headroom never reaches it,
      // and the region on it is the standing server's.
      await service
        .start({ steam_id: host, role: "user" } as never, {
          map_name: "de_mirage",
        })
        .catch((): undefined => undefined);

      const [session] = await postgres.query<Array<{ region: string }>>(
        "SELECT region FROM utility_practice_sessions",
      );
      expect(session?.region).toBe("TestA");
    });

    // Busy is worth waiting for; impossible is not. Queuing is what puts a max
    // length on everybody currently holding a server, so a row nothing can ever
    // serve costs every other player time and buys its author nothing.
    it("does not queue a player for a region that has no node to boot on", async () => {
      const host = await fx.player();
      await setting("public.utility_practice_enabled", "true");
      await setting("public.utility_practice_reserved_servers", "2");

      const service = makeService({
        matchAssistant: {
          countFreeOnDemandServers: jest.fn(async (): Promise<number> => 0),
          hasOnDemandNodes: jest.fn(async (): Promise<boolean> => false),
          practiceNodeIds: jest.fn(async (): Promise<string[]> => []),
        },
      });

      await expect(
        service.start({ steam_id: host, role: "user" } as never, {
          map_name: "de_mirage",
          region: "TestA",
        }),
      ).rejects.toThrow(/no practice server can be started in TestA/);

      const waiting = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM utility_practice_waitlist",
      );
      expect(waiting.length).toBe(0);
    });

    it("queues a player when the servers exist and are merely busy", async () => {
      const host = await fx.player();
      await setting("public.utility_practice_enabled", "true");
      await setting("public.utility_practice_reserved_servers", "2");

      const service = makeService({
        matchAssistant: {
          countFreeOnDemandServers: jest.fn(async (): Promise<number> => 2),
          hasOnDemandNodes: jest.fn(async (): Promise<boolean> => true),
        },
      });

      await expect(
        service.start({ steam_id: host, role: "user" } as never, {
          map_name: "de_mirage",
          region: "TestA",
        }),
      ).rejects.toThrow(/no practice servers are free/);

      const [waiting] = await postgres.query<Array<{ region: string }>>(
        "SELECT region FROM utility_practice_waitlist WHERE steam_id = $1",
        [host],
      );
      expect(waiting?.region).toBe("TestA");
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

  // Nothing serves this table -- it is only ever cleared by the same player
  // getting a server -- so an abandoned row used to say "somebody is waiting"
  // for the life of the database, and MAX_MINUTES then capped every session on
  // the install.
  describe("the waitlist", () => {
    async function waitlist(steamId: string, minutesAgo: number) {
      await postgres.query(
        `INSERT INTO utility_practice_waitlist (steam_id, map_name, region, created_at)
         VALUES ($1, 'de_mirage', 'TestA', now() - ($2 || ' minutes')::interval)`,
        [steamId, minutesAgo],
      );
    }

    it("drops entries older than the waiting window", async () => {
      const stale = await fx.player();
      const fresh = await fx.player();
      await waitlist(stale, UtilityPracticeService.WAITLIST_MINUTES + 5);
      await waitlist(fresh, 1);

      expect(await makeService({}).sweepWaitlist()).toBe(1);

      const rows = await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text AS steam_id FROM utility_practice_waitlist",
      );
      expect(rows.map(({ steam_id }) => steam_id)).toEqual([fresh]);
    });

    it("takes the waiting window from the settings table", async () => {
      const stale = await fx.player();
      await setting("public.utility_practice_waitlist_minutes", "5");
      // Inside the 30-minute default, outside the 5 the operator asked for.
      await waitlist(stale, 10);

      expect(await makeService({}).sweepWaitlist()).toBe(1);
    });

    // The reaper is the only reader of contention, so the sweep runs there
    // rather than on a timer of its own.
    it("is swept before the reaper reads contention", async () => {
      const stale = await fx.player();
      await waitlist(stale, UtilityPracticeService.WAITLIST_MINUTES + 5);

      await makeService({}).reapIdle();

      const rows = await postgres.query<Array<unknown>>(
        "SELECT 1 FROM utility_practice_waitlist",
      );
      expect(rows.length).toBe(0);
    });

    // What the flag is for: the session remembers that its host had been sent
    // away, so markReady knows there is somebody who stopped watching.
    it("marks a session that came out of the queue for a buzz", async () => {
      const host = await fx.player();
      await setting("public.utility_practice_enabled", "true");
      await standingPracticeServer("TestA");
      await waitlist(host, 1);

      // The match behind it needs hasura, which this suite does not stand up,
      // so it gets as far as the session row and no further.
      await makeService({})
        .start({ steam_id: host, role: "user" } as never, {
          map_name: "de_mirage",
        })
        .catch((): undefined => undefined);

      const [session] = await postgres.query<
        Array<{ notify_when_ready: boolean }>
      >("SELECT notify_when_ready FROM utility_practice_sessions");
      expect(session?.notify_when_ready).toBe(true);
    });

    it("leaves a walk-up session to the nav bar", async () => {
      const host = await fx.player();
      await setting("public.utility_practice_enabled", "true");
      await standingPracticeServer("TestA");

      await makeService({})
        .start({ steam_id: host, role: "user" } as never, {
          map_name: "de_mirage",
        })
        .catch((): undefined => undefined);

      const [session] = await postgres.query<
        Array<{ notify_when_ready: boolean }>
      >("SELECT notify_when_ready FROM utility_practice_sessions");
      expect(session?.notify_when_ready).toBe(false);
    });

    it("reports whether the player was actually queued", async () => {
      const queued = await fx.player();
      const walkUp = await fx.player();
      await waitlist(queued, 1);

      const service = makeService({});

      expect(await service.leaveWaitlist(queued)).toBe(true);
      expect(await service.leaveWaitlist(walkUp)).toBe(false);
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
      const { matchId, sessionId } = await liveSession({ is_open: true, access: "Open" });
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
      const service = makeService({});
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
      const { matchId, sessionId } = await liveSession({ is_open: true, access: "Open" });
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
        access: "Open",
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
        access: "Open",
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
      const { sessionId } = await liveSession({ is_open: true, access: "Open" });
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

  // The staff list's Stop and the panel's both land here, and both are shown
  // from can_stop, so stop() asks the same function. A render is a batch job
  // with nobody on it: only an administrator may cut one short.
  describe("stopping", () => {
    async function liveSession(): Promise<{ host: string; sessionId: string }> {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });
      return { host, sessionId };
    }

    async function status(sessionId: string): Promise<string> {
      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM utility_practice_sessions WHERE id = $1",
        [sessionId],
      );
      return row.status;
    }

    it.each([
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ])("lets a %s stop somebody else's server", async (role) => {
      const { sessionId } = await liveSession();
      const staff = await fx.player(undefined, role);
      const updateMatchStatus = jest.fn(async (): Promise<void> => undefined);
      const service = makeService({ matchAssistant: { updateMatchStatus } });

      await expect(
        service.stop({ steam_id: staff, role } as never, {
          session_id: sessionId,
        }),
      ).resolves.toEqual({ success: true });

      expect(await status(sessionId)).toBe("Ended");
      expect(updateMatchStatus).toHaveBeenCalledWith(
        expect.any(String),
        "Canceled",
      );
    });

    it.each(["user", "verified_user", "streamer"])(
      "refuses a %s who is not the host",
      async (role) => {
        const { sessionId } = await liveSession();
        const other = await fx.player(undefined, role);
        const service = makeService({});

        await expect(
          service.stop({ steam_id: other, role } as never, {
            session_id: sessionId,
          }),
        ).rejects.toThrow(/only the host/);

        expect(await status(sessionId)).toBe("Ready");
      },
    );

    it("lets the host stop their own server", async () => {
      const { host, sessionId } = await liveSession();
      const service = makeService({});

      await expect(
        service.stop({ steam_id: host, role: "user" } as never, {
          session_id: sessionId,
        }),
      ).resolves.toEqual({ success: true });

      expect(await status(sessionId)).toBe("Ended");
    });

    async function renderSession(): Promise<string> {
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_practice_sessions (map_name, is_render, status, access)
         VALUES ('de_mirage', true, 'Ready', 'Private')
         RETURNING id::text AS id`,
      );
      return row.id;
    }

    it.each(["moderator", "match_organizer", "tournament_organizer"])(
      "refuses a %s a render that is still filming",
      async (role) => {
        const sessionId = await renderSession();
        const staff = await fx.player(undefined, role);
        const service = makeService({});

        await expect(
          service.stop({ steam_id: staff, role } as never, {
            session_id: sessionId,
          }),
        ).rejects.toThrow(/only the host/);

        expect(await status(sessionId)).toBe("Ready");
      },
    );

    it("still lets an administrator end a render", async () => {
      const sessionId = await renderSession();
      const administrator = await fx.player(undefined, "administrator");
      const service = makeService({});

      await expect(
        service.stop(
          { steam_id: administrator, role: "administrator" } as never,
          {
            session_id: sessionId,
          },
        ),
      ).resolves.toEqual({ success: true });

      expect(await status(sessionId)).toBe("Ended");
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

  // The map lives in three places -- the session row, the match's one match_maps
  // row and the Custom pool behind it -- and every read picks a different one.
  // A change that moves fewer than all three leaves the plugin fetching a
  // library for a level the server is not running.
  describe("changing the map", () => {
    async function readyServer(
      host: string,
      port: number,
      overrides: Record<string, unknown> = {},
    ): Promise<{
      matchId: string;
      sessionId: string;
      serverId: string;
      lineupId: string;
    }> {
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
         VALUES ('127.0.0.1', $1, '\\x00'::bytea, $2, 'TestA', 'Practice', true, true, $3)
         RETURNING id::text AS id`,
        [`map-change-${port}`, port, matchId],
      );

      return { matchId, sessionId, serverId: server.id, lineupId };
    }

    async function mapOf(matchId: string): Promise<{
      session: string;
      matchMap: string;
      pool: string;
    }> {
      const [row] = await postgres.query<
        Array<{ session: string; match_map: string; pool: string }>
      >(
        `SELECT s.map_name AS session,
                mm_map.name AS match_map,
                pool_map.name AS pool
           FROM public.matches m
           INNER JOIN public.utility_practice_sessions s ON s.match_id = m.id
           INNER JOIN public.match_maps mm ON mm.match_id = m.id
           INNER JOIN public.maps mm_map ON mm_map.id = mm.map_id
           INNER JOIN public.match_options mo ON mo.id = m.match_options_id
           INNER JOIN public._map_pool mp ON mp.map_pool_id = mo.map_pool_id
           INNER JOIN public.maps pool_map ON pool_map.id = mp.map_id
          WHERE m.id = $1::uuid`,
        [matchId],
      );

      return { session: row.session, matchMap: row.match_map, pool: row.pool };
    }

    function asUser(steamId: string, role = "user") {
      return { steam_id: steamId, role } as never;
    }

    it("moves the session, the match map and the pool together", async () => {
      const host = await fx.player();
      const { matchId, sessionId, serverId } = await readyServer(host, 27700);

      const result = await makeService({}).changeMap(asUser(host), {
        session_id: sessionId,
        map_name: "de_inferno",
      });

      expect(result).toMatchObject({ success: true, map_name: "de_inferno" });
      expect(await mapOf(matchId)).toEqual({
        session: "de_inferno",
        matchMap: "de_inferno",
        pool: "de_inferno",
      });
      expect(rconSent).toEqual([
        { serverId, command: 'utility_practice_map "de_inferno"' },
      ]);
    });

    // map_name moves the moment the change is accepted, so without this every
    // "am I on the right map" check goes true ~15s before the level exists.
    it("marks the session as changing until the server reports the new map", async () => {
      const host = await fx.player();
      const { sessionId } = await readyServer(host, 27701);
      const service = makeService({});

      await service.changeMap(asUser(host), {
        session_id: sessionId,
        map_name: "de_inferno",
      });

      const changing = async () => {
        const [row] = await postgres.query<Array<{ changing: boolean }>>(
          `SELECT map_changing_at IS NOT NULL AS changing
             FROM utility_practice_sessions WHERE id = $1::uuid`,
          [sessionId],
        );
        return row.changing;
      };

      expect(await changing()).toBe(true);

      // The plugin came up on the map it was told to leave -- this fetch is
      // from before the changelevel, and clearing on it would be a lie.
      await service.markMapLoaded(sessionId, "de_mirage");
      expect(await changing()).toBe(true);

      await service.markMapLoaded(sessionId, "de_inferno");
      expect(await changing()).toBe(false);
    });

    // An old plugin build names no map. It is still a server that is up, and a
    // flag that never clears would refuse every load forever.
    it("clears the flag for a plugin that does not name its map", async () => {
      const host = await fx.player();
      const { sessionId } = await readyServer(host, 27702);
      const service = makeService({});

      await service.changeMap(asUser(host), {
        session_id: sessionId,
        map_name: "de_inferno",
      });
      await service.markMapLoaded(sessionId, null);

      const [row] = await postgres.query<Array<{ changing: boolean }>>(
        `SELECT map_changing_at IS NOT NULL AS changing
           FROM utility_practice_sessions WHERE id = $1::uuid`,
        [sessionId],
      );
      expect(row.changing).toBe(false);
    });

    // A changelevel takes everyone on the server through a load screen, so it
    // is the host's to call and nobody else's.
    it("refuses anyone but the host", async () => {
      const host = await fx.player();
      const guest = await fx.player();
      const { matchId, sessionId } = await readyServer(host, 27703);

      await expect(
        makeService({}).changeMap(asUser(guest), {
          session_id: sessionId,
          map_name: "de_inferno",
        }),
      ).rejects.toThrow(/only the host/);

      expect((await mapOf(matchId)).session).toBe("de_mirage");
      expect(rconSent).toEqual([]);
    });

    it("lets an administrator move somebody else's server", async () => {
      const host = await fx.player();
      const admin = await fx.player();
      const { matchId, sessionId } = await readyServer(host, 27704);

      await makeService({}).changeMap(asUser(admin, "administrator"), {
        session_id: sessionId,
        map_name: "de_inferno",
      });

      expect((await mapOf(matchId)).session).toBe("de_inferno");
    });

    // A Starting session's pod has +map baked into its job args: there is no
    // level running for a changelevel to replace.
    it("refuses a session that has not come up yet", async () => {
      const host = await fx.player();
      const { sessionId } = await readyServer(host, 27705, {
        status: "Starting",
      });

      await expect(
        makeService({}).changeMap(asUser(host), {
          session_id: sessionId,
          map_name: "de_inferno",
        }),
      ).rejects.toThrow(/not ready/);
    });

    it("refuses a map that is not available for practice", async () => {
      const host = await fx.player();
      const { sessionId } = await readyServer(host, 27706);

      await expect(
        makeService({}).changeMap(asUser(host), {
          session_id: sessionId,
          map_name: "de_not_a_map",
        }),
      ).rejects.toThrow(/not available for practice/);

      expect(rconSent).toEqual([]);
    });

    // The in-game wheel shows seven maps a page, so whatever sorts first is
    // all most players ever see of the list.
    it("lists Active Duty first in the in-game menu, then Valve's other maps, then workshop maps", async () => {
      const host = await fx.player();
      const { serverId } = await readyServer(host, 27726);

      const byName = await postgres.query<
        Array<{ name: string; active_pool: boolean; workshop: boolean }>
      >(
        `SELECT name, active_pool, workshop_map_id IS NOT NULL AS workshop
           FROM maps
          WHERE type = 'Competitive' AND enabled = true AND deleted_at IS NULL
          ORDER BY name`,
      );
      const names = (rows: typeof byName) => rows.map((map) => map.name);

      const menu = await makeService({}).mapsForServer(serverId, host);

      expect(menu?.maps).toEqual([
        ...names(byName.filter((map) => map.active_pool)),
        ...names(byName.filter((map) => !map.active_pool && !map.workshop)),
        ...names(byName.filter((map) => !map.active_pool && map.workshop)),
      ]);
    });

    // Pressing it twice, or landing on the map you are already on, must not
    // put anybody through a load screen for nothing.
    it("does nothing when the server is already on that map", async () => {
      const host = await fx.player();
      const { sessionId } = await readyServer(host, 27707);

      const result = await makeService({}).changeMap(asUser(host), {
        session_id: sessionId,
        map_name: "de_mirage",
      });

      expect(result).toMatchObject({ success: true, queued: false });
      expect(rconSent).toEqual([]);
    });

    // A scratch id is the caller's own string and it arrives inside an RCON
    // command line, which the source console splits on ';'. Everything else on
    // this path is a uuid the database handed back.
    it("refuses a scratch id that would carry its own commands", async () => {
      const host = await fx.player();
      const { sessionId } = await readyServer(host, 27718);

      await expect(
        makeService({}).changeMap(asUser(host), {
          session_id: sessionId,
          map_name: "de_inferno",
          scratch: {
            client_id: "x; sv_cheats 1; changelevel de_dust2",
            name: "smoke",
            map_name: "de_inferno",
            utility_type: "Smoke",
            side: "TERRORIST",
            technique: "Stationary",
            throw_strength: "Full",
            origin_x: -1912,
            origin_y: 922,
            origin_z: -167,
            eye_z: -103,
            view_yaw: 133.7,
            view_pitch: -12.4,
            land_x: -560,
            land_y: 320,
            land_z: -140,
          },
        }),
      ).rejects.toThrow(/not a lineup id/);

      expect(rconSent).toEqual([]);
    });

    // ...but "nothing to change level to" is not "nothing to do". The button
    // that switches map and stands you on a lineup is one call, and answering
    // success without sending the load leaves the player standing where they
    // were while the page says it worked.
    it("still sends the queued load when the map is already up", async () => {
      const host = await fx.player();
      const { sessionId, serverId } = await readyServer(host, 27717);
      const lineupId = await insertLineup(host, "de_mirage");

      const result = await makeService({}).changeMap(asUser(host), {
        session_id: sessionId,
        map_name: "de_mirage",
        lineup_id: lineupId,
      });

      expect(result).toMatchObject({ success: true, queued: true });
      expect(rconSent).toEqual([
        { serverId, command: `utility_practice_load ${host} ${lineupId}` },
      ]);
    });

    // The lock is what a double-clicked button runs into: two changelevels
    // stacked is a server that finishes loading neither.
    it("refuses a second change while one is in flight", async () => {
      const host = await fx.player();
      const { sessionId } = await readyServer(host, 27708);

      const service = makeService({
        cache: {
          acquireLock: jest.fn(async (): Promise<string | null> => null),
        },
      });

      await expect(
        service.changeMap(asUser(host), {
          session_id: sessionId,
          map_name: "de_inferno",
        }),
      ).rejects.toThrow(/already changing/);
    });

    // The whole point of the cross-map Practice button: the lineup rides with
    // the map change, because the caller spends the changelevel on a load
    // screen with no second moment to send anything.
    it("hands the plugin a lineup to stand the caller on", async () => {
      const host = await fx.player();
      const { sessionId, serverId } = await readyServer(host, 27709);
      const lineup = await insertLineup(host, "de_inferno");

      const result = await makeService({}).changeMap(asUser(host), {
        session_id: sessionId,
        map_name: "de_inferno",
        lineup_id: lineup,
      });

      expect(result.queued).toBe(true);
      expect(rconSent).toEqual([
        {
          serverId,
          command: `utility_practice_map "de_inferno" ${host} ${lineup}`,
        },
      ]);
    });

    // Checked BEFORE the level changes: refusing after everyone is already in a
    // load screen is the worst possible moment to find out.
    it("refuses a lineup the caller cannot see, without changing anything", async () => {
      const host = await fx.player();
      const stranger = await fx.player();
      const { matchId, sessionId } = await readyServer(host, 27710);
      const hidden = await insertLineup(stranger, "de_inferno");

      await expect(
        makeService({}).changeMap(asUser(host), {
          session_id: sessionId,
          map_name: "de_inferno",
          lineup_id: hidden,
        }),
      ).rejects.toThrow(/not available to you/);

      expect((await mapOf(matchId)).session).toBe("de_mirage");
      expect(rconSent).toEqual([]);
    });

    // A lineup for the map being LEFT is the same mistake as one nobody may
    // see: it would stand somebody in the middle of nothing.
    it("refuses a lineup that is not on the map being switched to", async () => {
      const host = await fx.player();
      const { sessionId } = await readyServer(host, 27711);
      const elsewhere = await insertLineup(host, "de_mirage");

      await expect(
        makeService({}).changeMap(asUser(host), {
          session_id: sessionId,
          map_name: "de_inferno",
          lineup_id: elsewhere,
        }),
      ).rejects.toThrow(/not available to you/);
    });

    // An old plugin build answers "Unknown command". The level change is still
    // worth making on its own -- but nothing there can hold a load across it,
    // so the caller must not be promised one.
    it("falls back to a plain changelevel on a plugin that predates the command", async () => {
      const host = await fx.player();
      const { sessionId, serverId } = await readyServer(host, 27712);
      const lineup = await insertLineup(host, "de_inferno");

      rconReply = (command) =>
        command.startsWith("utility_practice_map")
          ? 'Unknown command "utility_practice_map"'
          : "";

      const result = await makeService({}).changeMap(asUser(host), {
        session_id: sessionId,
        map_name: "de_inferno",
        lineup_id: lineup,
      });

      expect(result).toMatchObject({ success: true, queued: false });
      expect(rconSent[rconSent.length - 1]).toEqual({
        serverId,
        command: 'changelevel "de_inferno"',
      });
    });

    // One render pod films the whole queue, so its server follows it from map
    // to map. The system's own change: nobody is on the server to warn, and
    // nothing is stood anywhere on the far side.
    describe("a render session", () => {
      it("moves all three places and tells the server, with nobody queued", async () => {
        const host = await fx.player();
        const { matchId, sessionId, serverId } = await readyServer(
          host,
          27720,
          { is_render: true },
        );
        const service = makeService({});

        expect(await service.renderSessionForMatch(matchId)).toMatchObject({
          id: sessionId,
          map_name: "de_mirage",
          status: "Ready",
          map_changing_seconds: null,
        });

        await expect(
          service.changeRenderMap(sessionId, "de_inferno"),
        ).resolves.toBe("de_inferno");

        expect(await mapOf(matchId)).toEqual({
          session: "de_inferno",
          matchMap: "de_inferno",
          pool: "de_inferno",
        });
        expect(rconSent).toEqual([
          { serverId, command: 'utility_practice_map "de_inferno"' },
        ]);

        // Still loading as far as anybody can tell: the pod is not handed a
        // lineup until the plugin reports the level.
        const changing = await service.renderSessionForMatch(matchId);
        expect(changing?.map_name).toBe("de_inferno");
        expect(changing?.map_changing_seconds).not.toBeNull();

        await service.markMapLoaded(sessionId, "de_inferno");
        expect(
          (await service.renderSessionForMatch(matchId))?.map_changing_seconds,
        ).toBeNull();
      });

      it("puts the map back when the server cannot be reached", async () => {
        const host = await fx.player();
        const { matchId, sessionId } = await readyServer(host, 27721, {
          is_render: true,
        });

        rconReply = () => null;

        await expect(
          makeService({}).changeRenderMap(sessionId, "de_inferno"),
        ).rejects.toThrow(/could not reach/);

        expect(await mapOf(matchId)).toEqual({
          session: "de_mirage",
          matchMap: "de_mirage",
          pool: "de_mirage",
        });
        expect(
          (await makeService({}).renderSessionForMatch(matchId))
            ?.map_changing_seconds,
        ).toBeNull();
      });

      it("sends nothing when the server is already on the map", async () => {
        const host = await fx.player();
        const { sessionId } = await readyServer(host, 27722, {
          is_render: true,
        });

        await expect(
          makeService({}).changeRenderMap(sessionId, "de_mirage"),
        ).resolves.toBe("de_mirage");
        expect(rconSent).toEqual([]);
      });

      // The pod is a fact about the session: what the worker hands rows to
      // and what the GPU is held on. Read off the session's render rows it
      // vanished whenever they were deleted.
      it("remembers the pod started on it, and when it last asked for work", async () => {
        const host = await fx.player();
        const { matchId, sessionId } = await readyServer(host, 27724, {
          is_render: true,
        });
        const service = makeService({});

        expect(
          (await service.renderSessionForMatch(matchId))?.render_job_name,
        ).toBeNull();

        await service.markRenderPod(sessionId, "gs-nades-queue");
        expect(
          (await service.renderSessionForMatch(matchId))?.render_job_name,
        ).toBe("gs-nades-queue");

        await postgres.query(
          `UPDATE utility_practice_sessions
              SET render_seen_at = now() - interval '1 hour'
            WHERE id = $1::uuid`,
          [sessionId],
        );
        await service.touchRenderPod(sessionId);

        const [row] = await postgres.query<Array<{ recent: boolean }>>(
          `SELECT render_seen_at > now() - interval '1 minute' AS recent
             FROM utility_practice_sessions WHERE id = $1::uuid`,
          [sessionId],
        );
        expect(row.recent).toBe(true);
      });

      it("will not record a pod on somebody's own practice session", async () => {
        const host = await fx.player();
        const { sessionId } = await readyServer(host, 27725);

        await makeService({}).markRenderPod(sessionId, "gs-nades-queue");

        const [row] = await postgres.query<Array<{ pod: string | null }>>(
          `SELECT render_job_name AS pod
             FROM utility_practice_sessions WHERE id = $1::uuid`,
          [sessionId],
        );
        expect(row.pod).toBeNull();
      });

      it("knows which maps a server can be booked on at all", async () => {
        const service = makeService({});

        await expect(service.canPracticeOn("de_mirage")).resolves.toBe(true);
        await expect(service.canPracticeOn("de_nowhere")).resolves.toBe(false);

        // Disabled since its lineups were recorded: still a map, no longer
        // one to book.
        await postgres.query(
          "UPDATE maps SET enabled = false WHERE name = 'de_inferno' AND type = 'Competitive'",
        );
        try {
          await expect(service.canPracticeOn("de_inferno")).resolves.toBe(
            false,
          );
        } finally {
          await postgres.query(
            "UPDATE maps SET enabled = true WHERE name = 'de_inferno' AND type = 'Competitive'",
          );
        }
      });

      it("is not a way to move somebody's own practice server", async () => {
        const host = await fx.player();
        const { matchId, sessionId } = await readyServer(host, 27723);

        await expect(
          makeService({}).changeRenderMap(sessionId, "de_inferno"),
        ).rejects.toThrow(/not up/);
        expect(rconSent).toEqual([]);
        expect(await makeService({}).renderSessionForMatch(matchId)).toBeNull();
      });
    });

    // The row would otherwise claim a map the server was never told about, and
    // every read after that is answered for a level it is not running.
    it("puts the map back when the server cannot be reached", async () => {
      const host = await fx.player();
      const { matchId, sessionId } = await readyServer(host, 27713);

      rconReply = () => null;

      await expect(
        makeService({}).changeMap(asUser(host), {
          session_id: sessionId,
          map_name: "de_inferno",
        }),
      ).rejects.toThrow(/could not reach/);

      expect(await mapOf(matchId)).toEqual({
        session: "de_mirage",
        matchMap: "de_mirage",
        pool: "de_mirage",
      });

      const [row] = await postgres.query<Array<{ changing: boolean }>>(
        `SELECT map_changing_at IS NOT NULL AS changing
           FROM utility_practice_sessions WHERE id = $1::uuid`,
        [sessionId],
      );
      expect(row.changing).toBe(false);
    });

    // serverForPlayer is what every "load me in" button reads. During a switch
    // its map_name is where the server is GOING, so the flag has to travel with
    // it or the button sends a teleport to a player who is not there.
    it("tells the load path that the server is mid-switch", async () => {
      const host = await fx.player();
      const { sessionId, lineupId } = await readyServer(host, 27714);
      await postgres.query(
        `UPDATE match_lineup_players SET is_connected = true
          WHERE match_lineup_id = $1::uuid AND steam_id = $2::bigint`,
        [lineupId, host],
      );

      const load = makeLoadService();
      expect(await load.serverForPlayer(host)).toMatchObject({
        map_name: "de_mirage",
        switching: false,
      });

      await makeService({ load }).changeMap(asUser(host), {
        session_id: sessionId,
        map_name: "de_inferno",
      });

      expect(await load.serverForPlayer(host)).toMatchObject({
        map_name: "de_inferno",
        switching: true,
      });

      const sent = await load.sendToLineup(
        asUser(host),
        await insertLineup(host, "de_inferno"),
      );
      expect(sent).toMatchObject({ sent: false, reason: "map_switching" });
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

    it("lets an invitee in before they have joined from the site", async () => {
      const host = await fx.player();
      const invited = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
      });
      const serverId = await reservedServer("practice-a", matchId, 27964);

      const sendUtilityPracticeRefresh = jest.fn(
        async (): Promise<void> => undefined,
      );
      const service = makeService({
        matchAssistant: { sendUtilityPracticeRefresh },
      });

      await service.invite({ steam_id: host } as never, {
        session_id: sessionId,
        steam_ids: [invited],
      });

      expect(sendUtilityPracticeRefresh).toHaveBeenCalledWith(matchId);
      const session = await service.sessionForServer(serverId);
      expect(session?.steam_ids.sort()).toEqual([host, invited].sort());
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

    // GET /utility/session is asked once, at map load, and a plugin whose first
    // ask failed never asks again -- so the session sat Starting behind a server
    // that was up and posting. A practice pod pings nothing else, so this tick
    // is the only other proof there is.
    it("takes an occupancy tick as proof the server came up", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Starting",
      });
      const serverId = await reservedServer("practice-a", matchId, 27964);

      await makeService({}).reportOccupancy(serverId, []);

      const [session] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM utility_practice_sessions WHERE id = $1::uuid",
        [sessionId],
      );
      expect(session.status).toBe("Ready");
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

    // The backstop for a render session nothing is watching any more. One
    // session films the whole queue, so "nothing of its own in flight" is true
    // for a moment between every two lineups and across every level change.
    describe("render sessions", () => {
      async function oldRenderSession(): Promise<string> {
        const host = await fx.player();
        const { matchId } = await createPracticeMatch(host);
        const sessionId = await insertSession(host, {
          match_id: matchId,
          status: "Ready",
          is_render: true,
        });
        await postgres.query(
          `UPDATE utility_practice_sessions
              SET created_at = now() - make_interval(mins => $2)
            WHERE id = $1::uuid`,
          [sessionId, UtilityPracticeService.RENDER_GRACE_MINUTES + 5],
        );
        return sessionId;
      }

      async function filmed(
        sessionId: string,
        status: string,
        minutesAgo: number,
      ): Promise<void> {
        const author = await fx.player();
        const [lineup] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO utility_lineups
             (map_name, utility_type, side, technique,
              origin_x, origin_y, origin_z, view_yaw, view_pitch,
              land_x, land_y, land_z, name, author_steam_id, visibility)
           VALUES ('de_mirage', 'Smoke', 'TERRORIST', 'Jump',
                   1, 2, 3, 90, -20, 10, 20, 30, 'A main', $1::bigint, 'Private')
           RETURNING id::text AS id`,
          [author],
        );
        await postgres.query(
          `INSERT INTO utility_lineup_renders
             (utility_lineup_id, requested_by_steam_id, map_name, session_token,
              spec, status, utility_practice_session_id, last_status_at)
           VALUES ($1::uuid, $2::bigint, 'de_mirage', 'tok', '{}'::jsonb, $3,
                   $4::uuid, now() - make_interval(mins => $5))`,
          [lineup.id, author, status, sessionId, minutesAgo],
        );
      }

      const live = async (sessionId: string) => {
        const [row] = await postgres.query<Array<{ status: string }>>(
          "SELECT status FROM utility_practice_sessions WHERE id = $1::uuid",
          [sessionId],
        );
        return row.status === "Ready";
      };

      it("leaves one that finished a lineup a moment ago: it is between lineups", async () => {
        const sessionId = await oldRenderSession();
        await filmed(sessionId, "done", 1);

        await expect(makeService({}).reapRenderSessions()).resolves.toBe(0);
        expect(await live(sessionId)).toBe(true);
      });

      it("leaves one with a lineup still in flight, however long ago it last spoke", async () => {
        const sessionId = await oldRenderSession();
        await filmed(sessionId, "queued", 60);

        await expect(makeService({}).reapRenderSessions()).resolves.toBe(0);
        expect(await live(sessionId)).toBe(true);
      });

      it("ends one that has had nothing in flight and nothing to say for a while", async () => {
        const sessionId = await oldRenderSession();
        await filmed(
          sessionId,
          "done",
          UtilityPracticeService.RENDER_QUIET_MINUTES + 1,
        );

        await expect(
          serviceWithRealCancel().service.reapRenderSessions(),
        ).resolves.toBe(1);
        expect(await live(sessionId)).toBe(false);
      });
    });

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
      const sessionId = await insertSession(host, { is_open: true, access: "Open" });

      expect(await canView(sessionId, stranger)).toBe(true);
      expect(await canView(sessionId, null, "guest")).toBe(false);
    });

    // canJoin already lets the host's accepted friends into a Friends session;
    // without this they could never be shown it to join.
    it("shows a Friends session to the host's accepted friends, either way round", async () => {
      const host = await fx.player();
      const asked = await fx.player();
      const asking = await fx.player();
      await befriend(host, asked);
      await befriend(asking, host);
      const sessionId = await insertSession(host, { access: "Friends" });

      expect(await canView(sessionId, asked)).toBe(true);
      expect(await canView(sessionId, asking)).toBe(true);
    });

    it("keeps a Friends session from a request nobody has accepted", async () => {
      const host = await fx.player();
      const requested = await fx.player();
      const requesting = await fx.player();
      await befriend(host, requested, "Pending");
      await befriend(requesting, host, "Pending");
      const sessionId = await insertSession(host, { access: "Friends" });

      expect(await canView(sessionId, requested)).toBe(false);
      expect(await canView(sessionId, requesting)).toBe(false);
    });

    it("keeps a Friends session from a friend either side has blocked", async () => {
      const host = await fx.player();
      const blocked = await fx.player();
      const blocker = await fx.player();
      await befriend(host, blocked);
      await befriend(host, blocker);
      const sessionId = await insertSession(host, { access: "Friends" });
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
         VALUES ($1, $2), ($3, $1)`,
        [host, blocked, blocker],
      );

      expect(await canView(sessionId, blocked)).toBe(false);
      expect(await canView(sessionId, blocker)).toBe(false);
    });

    it.each(["Invite", "Private"])(
      "keeps an %s session from a friend nobody invited",
      async (access) => {
        const host = await fx.player();
        const friend = await fx.player();
        await befriend(host, friend);
        const sessionId = await insertSession(host, { access });

        expect(await canView(sessionId, friend)).toBe(false);
      },
    );

    it("gives a friend who can see the session nothing to connect with", async () => {
      const host = await fx.player();
      const friend = await fx.player();
      await befriend(host, friend);
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
        access: "Friends",
      });
      await postgres.query(
        `UPDATE matches
            SET server_id = (SELECT id FROM servers WHERE region = 'TestA' LIMIT 1)
          WHERE id = $1`,
        [matchId],
      );

      const connection = async (steamId: string) => {
        const [row] = await postgres.query<
          Array<{ link: string | null; connect: string | null }>
        >(
          `SELECT utility_practice_connection_link(s, $2::json) AS link,
                  utility_practice_connection_string(s, $2::json) AS connect
             FROM utility_practice_sessions s WHERE s.id = $1`,
          [sessionId, session(steamId)],
        );
        return row;
      };

      expect((await connection(host)).link).not.toBeNull();
      expect(await canView(sessionId, friend)).toBe(true);
      expect(await connection(friend)).toEqual({ link: null, connect: null });
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

  // connected_players is the column the plugin's occupancy report writes and the
  // reaper's idle clock reads, so what a viewer is shown is what decides when
  // an empty server is shut down. max_players is what join refuses at.
  describe("players on the server", () => {
    const viewer = (userId: string, role = "user") => ({ role, userId });

    async function sessionsAs(
      as: { role: string; userId: string },
      fields: Array<string> = ["id", "connected_players", "max_players"],
    ): Promise<Array<Record<string, unknown>>> {
      const params: Array<unknown> = [];
      const sql = await new HasuraPermissions(postgres).select(
        "utility_practice_sessions",
        "s",
        as,
        { fields },
        params,
      );
      return await postgres.query(
        `${sql} ORDER BY s.created_at`,
        params as Array<string>,
      );
    }

    async function liveSession(
      overrides: Record<string, unknown> = {},
    ): Promise<{ host: string; lineupId: string; sessionId: string }> {
      const host = await fx.player();
      const { matchId, lineupId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
        ...overrides,
      });
      return { host, lineupId, sessionId };
    }

    async function connect(lineupId: string, steamIds: Array<string>) {
      await postgres.query(
        `UPDATE match_lineup_players
            SET is_connected = true
          WHERE match_lineup_id = $1::uuid
            AND steam_id = ANY ($2::bigint[])`,
        [lineupId, steamIds],
      );
    }

    async function seated(lineupId: string, count: number) {
      const steamIds: Array<string> = [];
      for (let i = 0; i < count; i++) {
        steamIds.push(await fx.lineupPlayer(lineupId));
      }
      return steamIds;
    }

    it("counts nobody before anyone has connected", async () => {
      const { host, lineupId, sessionId } = await liveSession();
      await seated(lineupId, 2);

      expect(await sessionsAs(viewer(host))).toEqual([
        {
          id: sessionId,
          connected_players: 0,
          max_players: 5 + UtilityPracticeService.SUBSTITUTES,
        },
      ]);
    });

    it("counts the players connected, not the ones who joined", async () => {
      const { host, lineupId, sessionId } = await liveSession();
      const [first] = await seated(lineupId, 3);
      await connect(lineupId, [host, first]);

      expect(await sessionsAs(viewer(host))).toEqual([
        { id: sessionId, connected_players: 2, max_players: 10 },
      ]);
    });

    it("reads full once every seat the match holds is connected", async () => {
      const { host, lineupId, sessionId } = await liveSession();
      const guests = await seated(lineupId, 9);
      await connect(lineupId, [host, ...guests]);

      expect(await sessionsAs(viewer(host))).toEqual([
        { id: sessionId, connected_players: 10, max_players: 10 },
      ]);
    });

    // join refuses on seats, not on who is connected: a seat is held until
    // its player leaves, so a server can be full with nobody on it.
    it("reads full once every seat is taken, whoever is connected", async () => {
      const { host, lineupId, sessionId } = await liveSession();
      const guests = await seated(lineupId, 9);
      await connect(lineupId, guests.slice(0, 2));

      expect(
        await sessionsAs(viewer(host), [
          "id",
          "connected_players",
          "seated_players",
          "max_players",
          "is_full",
        ]),
      ).toEqual([
        {
          id: sessionId,
          connected_players: 2,
          seated_players: 10,
          max_players: 10,
          is_full: true,
        },
      ]);
    });

    it.each([
      [9, false],
      [10, true],
    ])(
      "agrees with join on whether %i seats taken is full",
      async (seats, full) => {
        const { host, lineupId, sessionId } = await liveSession({
          is_open: true,
          access: "Open",
        });
        await seated(lineupId, seats - 1);

        expect(await sessionsAs(viewer(host), ["is_full"])).toEqual([
          { is_full: full },
        ]);

        const attempt = makeService({}).join(
          { steam_id: await fx.player(), role: "user" } as never,
          { session_id: sessionId },
        );

        if (full) {
          await expect(attempt).rejects.toThrow(/full/);
        } else {
          await expect(attempt).resolves.toBeTruthy();
        }
      },
    );

    it("is not full before there is a server", async () => {
      const host = await fx.player();
      await insertSession(host);

      expect(
        await sessionsAs(viewer(host), ["seated_players", "is_full"]),
      ).toEqual([{ seated_players: 0, is_full: false }]);
    });

    it("takes the maximum from the match it runs on", async () => {
      const { host, sessionId } = await liveSession();
      await postgres.query(
        `UPDATE match_options mo
            SET number_of_substitutes = 2
           FROM matches m, utility_practice_sessions s
          WHERE s.id = $1 AND m.id = s.match_id AND mo.id = m.match_options_id`,
        [sessionId],
      );

      expect(await sessionsAs(viewer(host))).toEqual([
        { id: sessionId, connected_players: 0, max_players: 7 },
      ]);
    });

    it("has nobody on and no size before there is a server", async () => {
      const host = await fx.player();
      const sessionId = await insertSession(host);

      expect(await sessionsAs(viewer(host))).toEqual([
        { id: sessionId, connected_players: 0, max_players: null },
      ]);
    });

    it("gives the counts to everyone who can see the session", async () => {
      const { host, lineupId, sessionId } = await liveSession();
      const [member] = await seated(lineupId, 1);
      await connect(lineupId, [host, member]);
      const invited = await fx.player();
      await postgres.query(
        `INSERT INTO utility_practice_invites
           (utility_practice_session_id, steam_id, invited_by_steam_id)
         VALUES ($1, $2, $3)`,
        [sessionId, invited, host],
      );
      const moderator = await fx.player(undefined, "moderator");
      const administrator = await fx.player(undefined, "administrator");
      const counts = [{ id: sessionId, connected_players: 2, max_players: 10 }];

      expect(await sessionsAs(viewer(host))).toEqual(counts);
      expect(await sessionsAs(viewer(member))).toEqual(counts);
      expect(await sessionsAs(viewer(invited))).toEqual(counts);
      expect(await sessionsAs(viewer(moderator, "moderator"))).toEqual(counts);
      expect(await sessionsAs(viewer(administrator, "administrator"))).toEqual(
        counts,
      );
    });

    it("gives an open session's counts to any signed-in player", async () => {
      const { host, lineupId, sessionId } = await liveSession({
        is_open: true,
        access: "Open",
      });
      await connect(lineupId, [host]);
      const stranger = await fx.player();

      expect(await sessionsAs(viewer(stranger))).toEqual([
        { id: sessionId, connected_players: 1, max_players: 10 },
      ]);
    });

    it("tells a stranger nothing about a session they cannot see", async () => {
      const { host, lineupId } = await liveSession();
      await connect(lineupId, [host]);
      const stranger = await fx.player();

      expect(await sessionsAs(viewer(stranger))).toEqual([]);
    });
  });

  // can_manage is what the panel turns into Stop instead of Leave and into the
  // access, invite, playbook and map controls, all of which the api keeps to
  // the host. Staff get can_stop on top, never in place of Leave.
  describe("who drives a server and who may stop it", () => {
    async function rightsAs(sessionId: string, role: string, userId: string) {
      const params: Array<unknown> = [];
      const sql = await new HasuraPermissions(postgres).select(
        "utility_practice_sessions",
        "s",
        { role, userId },
        {
          fields: ["can_manage", "can_stop"],
          where: { id: { _eq: sessionId } },
        },
        params,
      );
      const [row] = await postgres.query<
        Array<{ can_manage: boolean; can_stop: boolean }>
      >(sql, params as Array<string>);
      return row;
    }

    async function liveSession(): Promise<{
      host: string;
      lineupId: string;
      sessionId: string;
    }> {
      const host = await fx.player();
      const { matchId, lineupId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ready",
        is_open: true,
        access: "Open",
      });
      return { host, lineupId, sessionId };
    }

    it("keeps driving and stopping to the host among players", async () => {
      const { host, lineupId, sessionId } = await liveSession();
      const guest = await fx.lineupPlayer(lineupId);
      const stranger = await fx.player();

      expect(await rightsAs(sessionId, "user", host)).toEqual({
        can_manage: true,
        can_stop: true,
      });
      expect(await rightsAs(sessionId, "user", guest)).toEqual({
        can_manage: false,
        can_stop: false,
      });
      expect(await rightsAs(sessionId, "user", stranger)).toEqual({
        can_manage: false,
        can_stop: false,
      });
    });

    it.each([
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ])(
      "lets a %s on somebody else's server stop it without driving it",
      async (role) => {
        const { lineupId, sessionId } = await liveSession();
        const staff = await fx.player(undefined, role);
        await fx.lineupPlayer(lineupId, staff);

        expect(await rightsAs(sessionId, role, staff)).toEqual({
          can_manage: false,
          can_stop: true,
        });
      },
    );

    it.each([
      ["moderator", false],
      ["match_organizer", false],
      ["tournament_organizer", false],
      ["administrator", true],
    ])("lets a %s stop a render: %s", async (role, allowed) => {
      const [render] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO utility_practice_sessions (map_name, is_render, status, access)
         VALUES ('de_mirage', true, 'Ready', 'Private')
         RETURNING id::text AS id`,
      );
      const staff = await fx.player(undefined, role);

      const [row] = await postgres.query<Array<{ ok: boolean }>>(
        `SELECT can_stop_utility_practice_session(s, $2::json) AS ok
           FROM utility_practice_sessions s WHERE s.id = $1`,
        [
          render.id,
          JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": staff }),
        ],
      );

      expect(row.ok).toBe(allowed);
    });
  });

  // Render and discovery pods book practice sessions too, but nobody is on
  // them and stopping one wastes a render halfway through, so the staff list
  // asks for is_render = false. It has to be a filter the staff roles may
  // write, not a column only administrators can name.
  describe("the staff list of running servers", () => {
    const live = {
      status: { _in: ["Starting", "Ready"] },
      is_render: { _eq: false },
    };

    async function listAs(role: string): Promise<Array<string>> {
      const userId = await fx.player(undefined, role);
      const params: Array<unknown> = [];
      const sql = await new HasuraPermissions(postgres).select(
        "utility_practice_sessions",
        "s",
        { role, userId },
        {
          fields: ["id", "connected_players", "max_players", "can_stop"],
          where: live,
        },
        params,
      );
      const rows = await postgres.query<Array<{ id: string }>>(
        `${sql} ORDER BY s.created_at`,
        params as Array<string>,
      );
      return rows.map(({ id }) => id);
    }

    it.each([
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ])("lists every live server but the pods for a %s", async (role) => {
      const ready = await insertSession(await fx.player(), { status: "Ready" });
      const starting = await insertSession(await fx.player(), {
        status: "Starting",
        access: "Private",
      });
      await insertSession(await fx.player(), { status: "Ended" });
      await postgres.query(
        `INSERT INTO utility_practice_sessions (map_name, is_render, status, access)
           VALUES ('de_mirage', true, 'Ready', 'Private'),
                  ('de_mirage', true, 'Starting', 'Private')`,
      );
      await postgres.query(
        `INSERT INTO utility_practice_sessions
             (map_name, is_render, is_discovery, status, access)
           VALUES ('de_mirage', true, true, 'Ready', 'Private')`,
      );

      expect(await listAs(role)).toEqual([ready, starting]);
    });

    it("is not a way for a player to list other people's servers", async () => {
      await insertSession(await fx.player(), { status: "Ready" });

      expect(await listAs("user")).toEqual([]);
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

  // The friends list asks each friend's player row for a server they host,
  // the way it already asks for their lobby and draft, so it only ever reads
  // its own friends' sessions and never every session on the site.
  describe("a friend's practice server in the friends list", () => {
    const hosted = (
      yaml.load(
        readFileSync(
          join(
            process.cwd(),
            "hasura/metadata/databases/default/tables/public_players.yaml",
          ),
          "utf8",
        ),
      ) as {
        array_relationships: Array<{
          name: string;
          using: { foreign_key_constraint_on: unknown };
        }>;
      }
    ).array_relationships.find(
      ({ name }) => name === "hosted_practice_sessions",
    );

    async function joinable(viewer: string): Promise<Array<string>> {
      const { column } = hosted!.using.foreign_key_constraint_on as {
        column: string;
      };
      const as = { role: "user", userId: viewer };
      const permissions = new HasuraPermissions(postgres);
      const params: Array<unknown> = [];
      const friends = await permissions.where(
        "v_my_friends",
        "select",
        "f",
        as,
        params,
      );
      const sessions = await permissions.where(
        "utility_practice_sessions",
        "select",
        "s",
        as,
        params,
      );
      params.push(["Open", "Friends"]);

      const rows = await postgres.query<Array<{ id: string }>>(
        `SELECT s.id::text AS id
           FROM v_my_friends f
           JOIN players p ON p.steam_id = f.steam_id
           JOIN utility_practice_sessions s ON s."${column}" = p.steam_id
          WHERE ${friends}
            AND ${sessions}
            AND s.status = 'Ready'
            AND s.access = ANY ($${params.length})
          ORDER BY s.created_at`,
        params as Array<string>,
      );
      return rows.map(({ id }) => id);
    }

    it("is reached from the host's player row", () => {
      expect(hosted?.using.foreign_key_constraint_on).toEqual({
        column: "host_steam_id",
        table: { name: "utility_practice_sessions", schema: "public" },
      });
    });

    it("lists the Open and Friends servers the viewer's friends host, and nothing else", async () => {
      const viewer = await fx.player();
      const friend = async () => {
        const steamId = await fx.player();
        await befriend(viewer, steamId);
        return steamId;
      };

      const friendsOnly = await insertSession(await friend(), {
        status: "Ready",
        access: "Friends",
      });
      const open = await insertSession(await friend(), {
        status: "Ready",
        is_open: true,
        access: "Open",
      });
      await insertSession(await friend(), {
        status: "Ready",
        access: "Private",
      });
      await insertSession(await friend(), {
        status: "Ready",
        access: "Invite",
      });
      await insertSession(await friend(), {
        status: "Starting",
        access: "Friends",
      });
      await insertSession(await friend(), {
        status: "Ended",
        access: "Friends",
      });

      const pending = await fx.player();
      await befriend(viewer, pending, "Pending");
      await insertSession(pending, { status: "Ready", access: "Friends" });

      const guest = await friend();
      const stranger = await fx.player();
      const { matchId, lineupId } = await createPracticeMatch(stranger);
      await fx.lineupPlayer(lineupId, guest);
      await insertSession(stranger, {
        match_id: matchId,
        status: "Ready",
        is_open: true,
        access: "Open",
      });

      expect(await joinable(viewer)).toEqual([friendsOnly, open]);
    });

    it("shows nobody else's friends' servers", async () => {
      const viewer = await fx.player();
      const host = await fx.player();
      const theirFriend = await fx.player();
      await befriend(host, theirFriend);
      await insertSession(host, { status: "Ready", access: "Friends" });

      expect(await joinable(viewer)).toEqual([]);
      expect(await joinable(theirFriend)).toHaveLength(1);
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

    it("skips a player on either side of a block without failing the rest", async () => {
      const host = await fx.player();
      const blockedByHost = await fx.player();
      const blockedHost = await fx.player();
      const friend = await fx.player();
      const sessionId = await insertSession(host, { status: "Ready" });
      await postgres.query(
        `INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id)
         VALUES ($1, $2), ($3, $1)`,
        [host, blockedByHost, blockedHost],
      );

      await makeService({}).invite({ steam_id: host } as never, {
        session_id: sessionId,
        steam_ids: [blockedByHost, blockedHost, friend],
      });

      const invited = await postgres.query<Array<{ steam_id: string }>>(
        `SELECT steam_id::text AS steam_id FROM utility_practice_invites
          WHERE utility_practice_session_id = $1`,
        [sessionId],
      );
      expect(invited.map((row) => row.steam_id)).toEqual([friend]);
      expect(notified).toHaveLength(1);
      expect(notified[0].steamIds).toEqual([friend]);
    });

    // The practice bar in the top nav says a server is booting and when it is
    // up, on every page, for as long as the session lasts -- so somebody who
    // pressed Start and stayed there is already being told, and a bell row a
    // moment later says the same thing worse.
    it("moves a session to Ready without buzzing anybody who was watching", async () => {
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

      expect(await statusOf(sessionId)).toBe("Ready");
      expect(notified).toHaveLength(0);
    });

    // The exception, and the only one: they were turned away, queued, and the
    // whole point of a queue is that you stop watching it.
    it("buzzes the session that had to wait for its turn", async () => {
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
        notify_when_ready: true,
      });

      await makeService({}).markReady(matchId);

      expect(notified).toHaveLength(1);
      expect(notified[0].type).toBe("UtilityPracticeReady");
      expect(notified[0].entity_id).toBe(`${sessionId}:ready`);
      // The host plus whoever was let into the lineup while it booted: the
      // link they were handed only starts working now.
      expect([...notified[0].steamIds].sort()).toEqual([host, mate].sort());
    });

    // The plugin polls GET /utility/session and the occupancy tick posts every
    // minute, so this runs over and over. Only the row the UPDATE actually
    // moved comes back, which is what keeps it one buzz rather than one a
    // minute for the life of the session.
    it("buzzes once however many times the plugin asks", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      await insertSession(host, {
        match_id: matchId,
        status: "Starting",
        notify_when_ready: true,
      });
      const service = makeService({});

      await service.markReady(matchId);
      await service.markReady(matchId);
      await service.markReady(matchId);

      expect(notified).toHaveLength(1);
    });

    // A late poll from a server that is being torn down must not put the
    // session back on the board.
    it("never brings a session back out of a terminal status", async () => {
      const host = await fx.player();
      const { matchId } = await createPracticeMatch(host);
      const sessionId = await insertSession(host, {
        match_id: matchId,
        status: "Ended",
      });

      await makeService({}).markReady(matchId);

      expect(await statusOf(sessionId)).toBe("Ended");
    });

    async function statusOf(sessionId: string): Promise<string> {
      const [session] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM utility_practice_sessions WHERE id = $1::uuid",
        [sessionId],
      );
      return session.status;
    }
  });
});
