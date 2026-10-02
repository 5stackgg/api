import { PostgresService } from "./../src/postgres/postgres.service";
import { ServerRosterService } from "./../src/server-roster/server-roster.service";
import { CommunityStatsService } from "./../src/server-roster/community-stats.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Just enough of ioredis for the roster and leaderboard caches, so the
// services run their real SQL against a real schema.
class FakeRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();

  async get(key: string) {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>) {
    if (args.includes("NX") && this.strings.has(key)) {
      return null;
    }
    this.strings.set(key, value);
    return "OK";
  }

  async exists(key: string) {
    return this.strings.has(key) || this.hashes.has(key) || this.zsets.has(key)
      ? 1
      : 0;
  }

  async del(...keys: Array<string>) {
    for (const key of keys) {
      this.strings.delete(key);
      this.hashes.delete(key);
      this.zsets.delete(key);
    }
    return keys.length;
  }

  async hset(key: string, ...args: Array<any>) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    if (typeof args[0] === "object") {
      for (const [field, value] of Object.entries(args[0])) {
        hash.set(field, String(value));
      }
    } else {
      hash.set(String(args[0]), String(args[1]));
    }
    this.hashes.set(key, hash);
    return 1;
  }

  async hget(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hmget(key: string, ...fields: Array<string>) {
    return fields.map((field) => this.hashes.get(key)?.get(field) ?? null);
  }

  async hincrby(key: string, field: string, by: number) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const next = Number(hash.get(field) ?? 0) + by;
    hash.set(field, String(next));
    this.hashes.set(key, hash);
    return next;
  }

  async hgetall(key: string) {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }

  async hdel(key: string, ...fields: Array<string>) {
    for (const field of fields) {
      this.hashes.get(key)?.delete(field);
    }
    return fields.length;
  }

  async zadd(key: string, ...args: Array<string | number>) {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    for (let index = 0; index < args.length; index += 2) {
      zset.set(String(args[index + 1]), Number(args[index]));
    }
    this.zsets.set(key, zset);
    return args.length / 2;
  }

  private ordered(key: string) {
    return [...(this.zsets.get(key) ?? new Map()).entries()].sort(
      (a, b) => b[1] - a[1] || b[0].localeCompare(a[0]),
    );
  }

  async zrevrange(key: string, start: number, stop: number) {
    return this.ordered(key)
      .slice(start, stop + 1)
      .map(([member]) => member);
  }

  async zrevrank(key: string, member: string) {
    const index = this.ordered(key).findIndex(([entry]) => entry === member);
    return index === -1 ? null : index;
  }

  async expire() {
    return 1;
  }

  async eval(_script: string, _keys: number, key: string, token: string) {
    if (this.strings.get(key) === token) {
      this.strings.delete(key);
      return 1;
    }
    return 0;
  }

  async sendCommand() {
    return 1;
  }

  multi() {
    const queued: Array<() => Promise<unknown>> = [];
    const chain: any = {
      exec: async (): Promise<Array<unknown>> => {
        for (const run of queued) {
          await run();
        }
        return [];
      },
    };
    for (const command of ["del", "zadd", "hset", "hincrby", "expire"]) {
      chain[command] = (...args: Array<any>) => {
        queued.push(() => (this as any)[command](...args));
        return chain;
      };
    }
    return chain;
  }
}

describe("server player sessions (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let redis: FakeRedis;
  let roster: ServerRosterService;
  let stats: CommunityStatsService;
  let serverId: string;

  const NYX = "76561198041234567";
  const MIKA = "76561197990771020";
  const STRANGER = "76561199433310288";

  const logger = { warn: jest.fn(), log: jest.fn() } as never;

  beforeAll(async () => {
    db = await bootMigratedDb("ServerPlayerSessions");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    redis = new FakeRedis();
    const redisManager = { getConnection: () => redis } as never;
    roster = new ServerRosterService(logger, postgres, redisManager);
    stats = new CommunityStatsService(logger, postgres, roster, redisManager);

    await postgres.query("DELETE FROM servers");

    for (const [steamId, role] of [
      [NYX, "user"],
      [MIKA, "moderator"],
    ]) {
      await postgres.query(
        `INSERT INTO players (steam_id, name, role, last_sign_in_at)
         VALUES ($1::bigint, $2, $3, now())
         ON CONFLICT (steam_id) DO UPDATE
            SET role = EXCLUDED.role, name = EXCLUDED.name,
                last_sign_in_at = EXCLUDED.last_sign_in_at`,
        [steamId, steamId === NYX ? "nyx" : "Mika", role],
      );
    }

    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan)
       VALUES ('TestRegion', 'TestRegion', true) ON CONFLICT (value) DO NOTHING`,
    );

    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, tv_port, region, type, is_dedicated,
          enabled, connected, max_players)
       VALUES ('10.0.0.1', 'Retake #1', $1, 27015, 27020, 'TestRegion', 'Retake',
               true, true, true, 12)
       RETURNING id`,
      [Buffer.from("password")],
    );

    serverId = server.id;
  });

  // Each player is on connection "<steam id>-a" unless a test says otherwise.
  const player = (
    steamId: string,
    overrides: Partial<{
      conn: string;
      name: string;
      ip: string;
      kills: number;
      deaths: number;
    }> = {},
  ) => ({
    steam_id: steamId,
    conn: overrides.conn ?? `${steamId}-a`,
    name: overrides.name ?? `name-${steamId.slice(-3)}`,
    ip: overrides.ip ?? "203.0.113.24",
    kills: overrides.kills ?? 0,
    deaths: overrides.deaths ?? 0,
  });

  const left = (
    steamId: string,
    kills: number,
    deaths = 0,
    conn = `${steamId}-a`,
  ) => ({ steam_id: steamId, conn, kills, deaths });

  async function sync(
    players: Array<ReturnType<typeof player>>,
    departed: Array<ReturnType<typeof left>> = [],
  ) {
    const [row] = await postgres.query<Array<{ online: number }>>(
      `SELECT public.sync_server_player_sessions($1, $2::jsonb, $3::jsonb) AS online`,
      [serverId, JSON.stringify(players), JSON.stringify(departed)],
    );
    return row.online;
  }

  async function sessions(steamId?: string) {
    return await postgres.query<
      Array<{
        id: string;
        player_steam_id: string;
        name: string;
        ip: string;
        kills: number;
        deaths: number;
        started_at: Date;
        ended_at: Date | null;
        xmin: string;
      }>
    >(
      `SELECT s.id::text AS id, s.player_steam_id::text AS player_steam_id, s.name,
              host(s.ip) AS ip, s.kills, s.deaths, s.started_at, s.ended_at,
              s.xmin::text AS xmin
         FROM server_player_sessions s
        WHERE s.server_id = $1
          AND ($2::bigint IS NULL OR s.player_steam_id = $2::bigint)
        ORDER BY s.id`,
      [serverId, steamId ?? null],
    );
  }

  async function totalKills(steamId: string) {
    const [row] = await postgres.query<Array<{ kills: number }>>(
      `SELECT coalesce(sum(kills), 0)::int AS kills FROM server_player_sessions
        WHERE server_id = $1 AND player_steam_id = $2::bigint`,
      [serverId, steamId],
    );
    return row.kills;
  }

  async function reportedAt() {
    const [row] = await postgres.query<Array<{ reported_at: Date }>>(
      `SELECT reported_at FROM server_rosters WHERE server_id = $1`,
      [serverId],
    );
    return new Date(row.reported_at);
  }

  async function age(minutes: number) {
    await postgres.query(
      `UPDATE server_player_sessions
          SET started_at = started_at - make_interval(mins => $2),
              ended_at = ended_at - make_interval(mins => $2)
        WHERE server_id = $1`,
      [serverId, minutes],
    );
    await postgres.query(
      `UPDATE server_rosters
          SET reported_at = reported_at - make_interval(mins => $2),
              held_since = held_since - make_interval(mins => $2)
        WHERE server_id = $1`,
      [serverId, minutes],
    );
  }

  async function sweep() {
    return await postgres.query<Array<{ server_id: string }>>(
      `SELECT closed.server_id::text AS server_id
         FROM public.close_stale_server_player_sessions(interval '3 minutes') AS closed(server_id)`,
    );
  }

  describe("sessions", () => {
    it("opens a session per player and reports how many are online", async () => {
      await expect(sync([player(NYX), player(STRANGER)])).resolves.toBe(2);

      const rows = await sessions();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.ended_at === null)).toBe(true);
    });

    it("writes nothing when the roster has not changed", async () => {
      await sync([player(NYX, { kills: 2 })]);
      const [before] = await sessions();

      await sync([player(NYX, { kills: 2 })]);
      const [after] = await sessions();

      expect(after.xmin).toBe(before.xmin);
    });

    it("closes the sessions of players who are gone", async () => {
      await sync([player(NYX), player(STRANGER)]);
      await sync([player(NYX)]);

      const [stranger] = await sessions(STRANGER);
      expect(stranger.ended_at).not.toBeNull();

      await sync([]);
      expect((await sessions()).every((row) => row.ended_at !== null)).toBe(
        true,
      );
    });

    it("continues the session when a player reconnects within two minutes", async () => {
      await sync([player(NYX)]);
      await sync([]);
      await age(1);

      await sync([player(NYX, { conn: `${NYX}-b` })]);

      const rows = await sessions(NYX);
      expect(rows).toHaveLength(1);
      expect(rows[0].ended_at).toBeNull();
    });

    it("starts a new session when a player comes back later", async () => {
      await sync([player(NYX)]);
      await sync([]);
      await age(5);

      await sync([player(NYX, { conn: `${NYX}-b` })]);

      const rows = await sessions(NYX);
      expect(rows).toHaveLength(2);
      expect(rows[0].ended_at).not.toBeNull();
      expect(rows[1].ended_at).toBeNull();
    });

    it("splits a session across a server restart, ending it where the roster went quiet", async () => {
      await sync([player(NYX)]);
      await age(10);
      const quiet = await reportedAt();

      await sync([player(NYX, { conn: `${NYX}-b` })]);

      const rows = await sessions(NYX);
      expect(rows).toHaveLength(2);
      expect(rows[0].ended_at?.getTime()).toBe(quiet.getTime());
      expect(rows[1].ended_at).toBeNull();
    });

    it("keeps one session for a player who stayed connected through a panel outage", async () => {
      await sync([player(NYX)]);
      await age(10);

      await sync([player(NYX)]);

      const rows = await sessions(NYX);
      expect(rows).toHaveLength(1);
      expect(rows[0].ended_at).toBeNull();
    });

    it("refreshes a player's name and ip without starting a session", async () => {
      await sync([player(NYX, { name: "nyx" })]);
      await sync([
        player(NYX, { name: "nyx | 5stack.gg", ip: "198.51.100.58" }),
      ]);

      const rows = await sessions(NYX);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "nyx | 5stack.gg",
        ip: "198.51.100.58",
      });
    });

    it("never opens two sessions for one player under concurrent syncs", async () => {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          sync(
            index % 2 === 0
              ? [player(NYX, { kills: index })]
              : [player(NYX, { kills: index }), player(STRANGER)],
          ),
        ),
      );

      const rows = await sessions(NYX);
      expect(rows.filter((row) => row.ended_at === null)).toHaveLength(1);
      expect(await totalKills(NYX)).toBe(7);
    });
  });

  describe("kills", () => {
    it("counts the growth of a connection's counters, never a resend", async () => {
      await sync([player(NYX, { kills: 3, deaths: 1 })]);
      await sync([player(NYX, { kills: 5, deaths: 2 })]);
      await sync([player(NYX, { kills: 5, deaths: 2 })]);

      expect((await sessions(NYX))[0]).toMatchObject({ kills: 5, deaths: 2 });
    });

    it("keeps a departed player's final kills, once", async () => {
      await sync([player(NYX, { kills: 1 })]);
      await sync([], [left(NYX, 4, 2)]);
      await sync([], [left(NYX, 4, 2)]);

      const [row] = await sessions(NYX);
      expect(row).toMatchObject({ kills: 4, deaths: 2 });
      expect(row.ended_at).not.toBeNull();
    });

    it("adds a new connection's kills to a continued session", async () => {
      await sync([player(NYX, { kills: 7 })]);
      await sync([], [left(NYX, 7)]);
      await age(1);

      await sync([player(NYX, { conn: `${NYX}-b`, kills: 2 })]);

      const rows = await sessions(NYX);
      expect(rows).toHaveLength(1);
      expect(rows[0].kills).toBe(9);
    });

    it("counts both connections when a player rejoins between syncs, even when resent", async () => {
      await sync([player(NYX, { kills: 3 })]);

      const body: [
        Array<ReturnType<typeof player>>,
        Array<ReturnType<typeof left>>,
      ] = [[player(NYX, { conn: `${NYX}-b`, kills: 1 })], [left(NYX, 5)]];

      await sync(...body);
      expect(await totalKills(NYX)).toBe(6);

      await sync(...body);
      expect(await totalKills(NYX)).toBe(6);

      await sync([player(NYX, { conn: `${NYX}-b`, kills: 2 })]);
      expect(await totalKills(NYX)).toBe(7);
      expect(await sessions(NYX)).toHaveLength(1);
    });

    it("does not count a connection twice after a panel outage", async () => {
      await sync([player(NYX, { kills: 20, deaths: 5 })]);
      await age(3);

      await sync([player(NYX, { kills: 22, deaths: 5 })]);

      expect(await sessions(NYX)).toHaveLength(1);
      expect(await totalKills(NYX)).toBe(22);
    });

    it("does not count a connection twice after the sweeper closed it", async () => {
      await sync([player(NYX, { kills: 20 })]);
      await age(4);
      await sweep();

      await sync([player(NYX, { kills: 22 })]);

      expect(await sessions(NYX)).toHaveLength(1);
      expect(await totalKills(NYX)).toBe(22);
    });

    it("keeps both servers' worth of kills across a restart", async () => {
      await sync([player(NYX, { kills: 20 })]);
      await age(10);

      await sync([player(NYX, { conn: `${NYX}-b`, kills: 3 })]);

      expect(await totalKills(NYX)).toBe(23);
    });

    it("adds a connection the panel never saw, once", async () => {
      await sync([player(NYX, { kills: 10 })]);
      await sync([], [left(NYX, 10)]);

      await sync([], [left(NYX, 12, 0, `${NYX}-unseen`)]);
      await sync([], [left(NYX, 12, 0, `${NYX}-unseen`)]);

      expect(await totalKills(NYX)).toBe(22);
    });
  });

  describe("held rosters", () => {
    it("keeps sessions whole while the plugin holds its roster", async () => {
      await roster.apply(serverId, [player(NYX)], []);

      for (let step = 0; step < 3; step++) {
        await age(1);
        await roster.apply(serverId, null, []);
      }

      await roster.apply(serverId, [player(NYX, { conn: `${NYX}-b` })], []);

      const rows = await sessions(NYX);
      expect(rows).toHaveLength(1);
      expect(rows[0].ended_at).toBeNull();
    });

    it("does not revive a roster that already went quiet", async () => {
      await roster.apply(serverId, [player(NYX)], []);
      await age(5);
      const quiet = await reportedAt();

      await roster.apply(serverId, null, []);

      expect((await reportedAt()).getTime()).toBe(quiet.getTime());
    });

    it("stops holding a roster after five minutes", async () => {
      await roster.apply(serverId, [player(NYX)], []);

      for (let step = 0; step < 7; step++) {
        await age(1);
        await roster.apply(serverId, null, []);
      }

      expect(Date.now() - (await reportedAt()).getTime()).toBeGreaterThan(
        90_000,
      );
    });

    it("answers whether the roster was recorded", async () => {
      await expect(roster.apply(serverId, [player(NYX)], [])).resolves.toBe(
        true,
      );
      await expect(roster.apply(serverId, null, [])).resolves.toBe(false);
    });
  });

  describe("sweeping and pruning", () => {
    it("closes the sessions of a server whose roster went quiet", async () => {
      await sync([player(NYX)]);
      await age(4);

      const closed = await sweep();

      expect(closed.map((row) => row.server_id)).toEqual([serverId]);
      expect((await sessions(NYX))[0].ended_at).not.toBeNull();
    });

    it("leaves a roster that is still reporting alone", async () => {
      await sync([player(NYX)]);

      expect(await sweep()).toHaveLength(0);
    });

    it("keeps all-time totals identical when old sessions are pruned", async () => {
      await sync([player(NYX, { kills: 4, deaths: 1 }), player(STRANGER)]);
      await sync([player(STRANGER)], [left(NYX, 4, 1)]);
      await age(60 * 24 * 10);
      await sync([
        player(NYX, { conn: `${NYX}-b`, kills: 2 }),
        player(STRANGER, { conn: `${STRANGER}-b` }),
      ]);
      await sync([]);

      const totals = async () =>
        await postgres.query(
          `SELECT player_steam_id::text, sessions, kills, deaths, seconds_played,
                  first_seen_at, last_seen_at
             FROM v_server_player_totals
            WHERE server_id = $1
            ORDER BY player_steam_id`,
          [serverId],
        );

      const before = await totals();

      const [{ pruned }] = await postgres.query<Array<{ pruned: number }>>(
        `SELECT public.prune_server_player_sessions(now() - interval '7 days', 1000) AS pruned`,
      );

      expect(pruned).toBe(2);
      expect(await totals()).toEqual(before);
      expect(await sessions()).toHaveLength(2);
    });

    it("never prunes a session that is still open", async () => {
      await sync([player(NYX)]);
      await age(60 * 24 * 10);
      await postgres.query(
        `UPDATE server_rosters SET reported_at = now() WHERE server_id = $1`,
        [serverId],
      );

      const [{ pruned }] = await postgres.query<Array<{ pruned: number }>>(
        `SELECT public.prune_server_player_sessions(now() - interval '7 days', 1000) AS pruned`,
      );

      expect(pruned).toBe(0);
      expect((await sessions(NYX))[0].ended_at).toBeNull();
    });
  });

  describe("recent players and activity", () => {
    it("aggregates the last seven days per player", async () => {
      await sync([player(NYX, { kills: 3 }), player(STRANGER)]);
      await sync([player(STRANGER)], [left(NYX, 3)]);
      await postgres.query(
        `INSERT INTO server_player_sessions
           (server_id, player_steam_id, conn, kills, started_at, ended_at)
         VALUES ($1, $2::bigint, 'old', 50, now() - interval '20 days', now() - interval '19 days')`,
        [serverId, NYX],
      );

      const rows = await postgres.query<
        Array<{
          player_steam_id: string;
          sessions: number;
          kills: number;
          online: boolean;
          ip: string;
        }>
      >(
        `SELECT player_steam_id::text, sessions, kills, online, ip
           FROM server_recent_players
          WHERE server_id = $1
          ORDER BY player_steam_id`,
        [serverId],
      );

      expect(rows).toEqual([
        {
          player_steam_id: NYX,
          sessions: 1,
          kills: 3,
          online: false,
          ip: "203.0.113.24",
        },
        {
          player_steam_id: STRANGER,
          sessions: 1,
          kills: 0,
          online: true,
          ip: "203.0.113.24",
        },
      ]);
    });

    it("reads one server's recent players through the sessions index", async () => {
      const plan = await postgres.transaction(async (client) => {
        await client.query("SET LOCAL enable_seqscan = off");
        const result = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT * FROM server_recent_players WHERE server_id = $1`,
          [serverId],
        );
        return JSON.stringify(result.rows[0]["QUERY PLAN"]);
      });

      expect(plan).toMatch(/"Index Cond":"\(server_id = /);
    });

    it("spreads a session's seconds across the hours it covers", async () => {
      await postgres.query(
        `INSERT INTO server_player_sessions (server_id, player_steam_id, started_at, ended_at)
         VALUES ($1, $2::bigint,
                 date_trunc('hour', now()) - interval '90 minutes',
                 date_trunc('hour', now()) - interval '30 minutes')`,
        [serverId, NYX],
      );

      const hours = await postgres.query<
        Array<{ hour: Date; seconds: number; players: number }>
      >(`SELECT * FROM public.server_hourly_activity($1, 3)`, [serverId]);

      expect(hours.map((hour) => hour.seconds)).toEqual([1800, 1800, 0]);
      expect(hours.map((hour) => hour.players)).toEqual([1, 1, 0]);
    });
  });

  describe("community stats", () => {
    const SHADOW = "76561199000000999";

    beforeEach(async () => {
      await postgres.query(
        `INSERT INTO players (steam_id, name, role) VALUES ($1::bigint, 'shadow', 'user')
         ON CONFLICT (steam_id) DO UPDATE SET last_sign_in_at = NULL`,
        [SHADOW],
      );

      await sync([
        player(NYX, { kills: 9 }),
        player(MIKA, { kills: 4 }),
        player(STRANGER, { kills: 30 }),
        player(SHADOW, { kills: 50 }),
      ]);
      await postgres.query(
        `UPDATE server_player_sessions
            SET started_at = now() - interval '2 hours'
          WHERE player_steam_id = $1::bigint`,
        [NYX],
      );
    });

    it("ranks only players who signed in to 5stack", async () => {
      const board = await stats.leaderboard(serverId, "week", "kills", 10, {
        steam_id: MIKA,
        role: "moderator",
      } as never);

      expect(board.entries.map((entry) => entry.steam_id)).toEqual([NYX, MIKA]);
      expect(board.entries[0]).toMatchObject({
        rank: 1,
        name: "nyx",
        kills: 9,
      });
      expect(board.you).toMatchObject({ rank: 2, steam_id: MIKA });
    });

    // A cached board used to keep its numbers for two minutes whatever happened
    // on the server in the meantime.
    it("rebuilds the board as soon as someone leaves", async () => {
      const before = await stats.leaderboard(serverId, "week", "kills", 10);
      expect(before.entries[0].steam_id).toBe(NYX);

      await roster.apply(
        serverId,
        [
          player(NYX, { kills: 9 }),
          player(STRANGER, { kills: 30 }),
          player(SHADOW, { kills: 50 }),
        ],
        [left(MIKA, 20)],
      );

      const after = await stats.leaderboard(serverId, "week", "kills", 10);
      expect(after.entries[0]).toMatchObject({ steam_id: MIKA, kills: 20 });
    });

    it("ranks by time played", async () => {
      const board = await stats.leaderboard(serverId, "all", "time", 10);

      expect(board.entries[0].steam_id).toBe(NYX);
      expect(board.you).toBeNull();
    });

    it("hides a restricted server's board from players it does not let in", async () => {
      await postgres.query(
        `UPDATE servers SET access_restricted = true WHERE id = $1`,
        [serverId],
      );

      const board = await stats.leaderboard(serverId, "week", "time", 10, {
        steam_id: NYX,
        role: "user",
      } as never);

      expect(board.entries).toEqual([]);
    });

    it("hides a password-protected server from roles that cannot join it", async () => {
      await postgres.query(
        `UPDATE servers SET connect_password = 'secret' WHERE id = $1`,
        [serverId],
      );
      await postgres.query(
        `INSERT INTO settings (name, value) VALUES ('dedicated_servers_min_role_to_connect', 'verified_user')
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      );

      await expect(stats.serverStats(serverId)).resolves.toBeNull();
      await expect(
        stats.serverStats(serverId, {
          steam_id: MIKA,
          role: "moderator",
        } as never),
      ).resolves.not.toBeNull();

      await postgres.query(
        `DELETE FROM settings WHERE name = 'dedicated_servers_min_role_to_connect'`,
      );
    });

    it("never shows a Ranked server's numbers to the public", async () => {
      await postgres.query(`UPDATE servers SET type = 'Ranked' WHERE id = $1`, [
        serverId,
      ]);

      await expect(stats.serverStats(serverId)).resolves.toBeNull();
    });

    it("gives everyone totals but only moderators the exact times and ips", async () => {
      const publicView = await stats.playerStats(NYX, {
        steam_id: MIKA,
        role: "user",
      } as never);

      expect(publicView.is_moderator_view).toBe(false);
      expect(publicView.week).toMatchObject({
        sessions: 1,
        kills: 9,
        servers: 1,
      });
      expect(publicView.servers[0]).toMatchObject({
        label: "Retake #1",
        online: true,
        names: null,
        sessions: null,
      });
      expect(publicView.servers[0].week.rank).toBe(1);
      expect(publicView.ips).toBeNull();
      expect(publicView.ip_matches).toBeNull();
      expect(new Date(publicView.last_seen_at).getUTCMinutes()).toBe(0);

      const moderatorView = await stats.playerStats(NYX, {
        steam_id: MIKA,
        role: "moderator",
      } as never);

      expect(moderatorView.is_moderator_view).toBe(true);
      expect(moderatorView.servers[0].sessions).toHaveLength(1);
      expect(moderatorView.ips).toEqual([{ ip: "203.0.113.24", sessions: 1 }]);

      const accounts = Object.fromEntries(
        moderatorView.ip_matches.map(
          (match: { steam_id: string; has_account: boolean }) => [
            match.steam_id,
            match.has_account,
          ],
        ),
      );
      expect(accounts).toEqual({
        [MIKA]: true,
        [STRANGER]: false,
        [SHADOW]: false,
      });
    });

    it("reports a server's week and hourly activity", async () => {
      const server = await stats.serverStats(serverId);

      expect(server).toMatchObject({
        server_id: serverId,
        online: 4,
        max_players: 12,
        week_players: 4,
        all_time_players: 4,
      });
      expect(server.hourly).toHaveLength(168);
    });
  });
});
