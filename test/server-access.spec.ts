import { PostgresService } from "./../src/postgres/postgres.service";
import { ServerAccessService } from "./../src/dedicated-servers/server-access.service";
import { DedicatedServerConfigService } from "./../src/dedicated-servers/dedicated-server-config.service";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Who a restricted community server lets in, resolved against the real schema:
// the allowlist the Player Management plugin enforces and the connect info the
// panel shows or hides.
describe("server access (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let access: ServerAccessService;
  let config: DedicatedServerConfigService;

  const rconSend = jest.fn(async (): Promise<string> => "");

  const OWNER = "76561190000000100";
  const PICKED = "76561190000000101";
  const VERIFIED = "76561190000000102";
  const MODERATOR = "76561190000000103";
  const EVENT_PLAYER = "76561190000000104";
  const TEAM_PLAYER = "76561190000000105";
  const STRANGER = "76561190000000106";

  beforeAll(async () => {
    db = await bootMigratedDb("ServerAccess");
    postgres = db.postgres;
    access = new ServerAccessService(postgres);
    config = new DedicatedServerConfigService(
      { warn: jest.fn(), log: jest.fn() } as never,
      postgres,
      {} as never,
      { connect: jest.fn(async () => ({ send: rconSend })) } as never,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  let serverId: string;

  beforeEach(async () => {
    rconSend.mockClear();

    await postgres.query("DELETE FROM servers");
    await postgres.query("DELETE FROM events");

    const roles: Array<[string, string]> = [
      [OWNER, "user"],
      [PICKED, "user"],
      [VERIFIED, "verified_user"],
      [MODERATOR, "moderator"],
      [EVENT_PLAYER, "user"],
      [TEAM_PLAYER, "user"],
      [STRANGER, "user"],
    ];

    for (const [steamId, role] of roles) {
      await postgres.query(
        `INSERT INTO players (steam_id, name, role) VALUES ($1::bigint, $1::text, $2)
         ON CONFLICT (steam_id) DO UPDATE SET role = EXCLUDED.role`,
        [steamId, role],
      );
    }

    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan)
       VALUES ('TestRegion', 'TestRegion', true) ON CONFLICT (value) DO NOTHING`,
    );

    const [server] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO servers
         (host, label, rcon_password, port, tv_port, region, type, is_dedicated,
          enabled, connected)
       VALUES ('10.0.0.1', 'prophunt', $1, 27015, 27020, 'TestRegion', 'Casual',
               true, true, true)
       RETURNING id`,
      [Buffer.from("password")],
    );

    serverId = server.id;
  });

  // Rosters can't be torn down between tests (an owner may not leave their
  // team), so one team is built once and only ever grows.
  let squadId: string | undefined;

  const squad = async (steamIds: Array<string>): Promise<string> => {
    if (!squadId) {
      const [team] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO teams (name, short_name, owner_steam_id)
         VALUES ('Squad', 'SQD', $1) RETURNING id`,
        [OWNER],
      );
      squadId = team.id;
    }

    for (const steamId of steamIds) {
      await runAsUser(postgres, OWNER, "admin", (query) =>
        query(
          `INSERT INTO team_roster (team_id, player_steam_id, status)
           VALUES ($1, $2, 'Starter') ON CONFLICT DO NOTHING`,
          [squadId, steamId],
        ),
      );
    }

    return squadId;
  };

  const allowed = async (): Promise<Array<string>> =>
    (await access.allowlist(serverId)).steamIds;

  const event = async (
    window: { starts: string | null; ends: string | null },
    members: { players?: Array<string>; teamPlayers?: Array<string> } = {},
  ): Promise<string> => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO events (name, organizer_steam_id, starts_at, ends_at)
       VALUES ('LAN', $1, now() + $2::interval, now() + $3::interval)
       RETURNING id`,
      [OWNER, window.starts ?? "-100 years", window.ends ?? "100 years"],
    );

    if (window.starts === null || window.ends === null) {
      await postgres.query(
        `UPDATE events
            SET starts_at = CASE WHEN $2 THEN NULL ELSE starts_at END,
                ends_at = CASE WHEN $3 THEN NULL ELSE ends_at END
          WHERE id = $1`,
        [row.id, window.starts === null, window.ends === null],
      );
    }

    for (const steamId of members.players ?? []) {
      await postgres.query(
        `INSERT INTO event_players (event_id, steam_id) VALUES ($1, $2)`,
        [row.id, steamId],
      );
    }

    if (members.teamPlayers?.length) {
      await postgres.query(
        `INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)`,
        [row.id, await squad(members.teamPlayers)],
      );
    }

    return row.id;
  };

  const restrict = async (
    rules: {
      minRole?: string | null;
      steamIds?: Array<string>;
      eventIds?: Array<string>;
    } = {},
  ): Promise<void> => {
    await config.setAccess(serverId, {
      restricted: true,
      minRole: rules.minRole ?? null,
      steamIds: rules.steamIds ?? [],
      eventIds: rules.eventIds ?? [],
    });
  };

  const connectionFor = async (
    session: Record<string, string>,
  ): Promise<string | null> => {
    const [row] = await postgres.query<Array<{ value: string | null }>>(
      `SELECT get_server_connection_string(s, $2::json) AS value
         FROM servers s WHERE s.id = $1`,
      [serverId, JSON.stringify(session)],
    );

    return row.value;
  };

  const guest = { "x-hasura-role": "guest", "x-hasura-user-id": "0" };
  const user = (steamId: string, role = "user") => ({
    "x-hasura-role": role,
    "x-hasura-user-id": steamId,
  });

  describe("the allowlist", () => {
    it("is open until the server is restricted", async () => {
      expect(await access.allowlist(serverId)).toEqual({
        restricted: false,
        version: "open",
        steamIds: [],
      });
    });

    it("lets in picked players and always staff", async () => {
      await restrict({ steamIds: [PICKED] });

      expect(await allowed()).toEqual(
        expect.arrayContaining([PICKED, MODERATOR]),
      );
      expect(await allowed()).not.toContain(STRANGER);
    });

    it("lets in everyone at or above the minimum role", async () => {
      await restrict({ minRole: "verified_user" });

      expect(await allowed()).toEqual(
        expect.arrayContaining([VERIFIED, MODERATOR]),
      );
      expect(await allowed()).not.toContain(PICKED);
    });

    it("lets in members of an event while it runs", async () => {
      const running = await event(
        { starts: "-1 hour", ends: "1 hour" },
        { players: [EVENT_PLAYER], teamPlayers: [TEAM_PLAYER] },
      );
      await restrict({ eventIds: [running] });

      expect(await allowed()).toEqual(
        expect.arrayContaining([OWNER, EVENT_PLAYER, TEAM_PLAYER]),
      );
      expect(await allowed()).not.toContain(STRANGER);
    });

    it("lets nobody in through an event that has not started or has ended", async () => {
      const upcoming = await event(
        { starts: "1 day", ends: "2 days" },
        { players: [EVENT_PLAYER] },
      );
      const over = await event(
        { starts: "-2 days", ends: "-1 day" },
        { players: [TEAM_PLAYER] },
      );
      await restrict({ eventIds: [upcoming, over] });

      expect(await allowed()).not.toContain(EVENT_PLAYER);
      expect(await allowed()).not.toContain(TEAM_PLAYER);
    });

    it("keeps an event with no end date running", async () => {
      const openEnded = await event(
        { starts: "-1 hour", ends: null },
        { players: [EVENT_PLAYER] },
      );
      await restrict({ eventIds: [openEnded] });

      expect(await allowed()).toContain(EVENT_PLAYER);
    });
  });

  describe("the sync", () => {
    it("names the present players who are not allowed", async () => {
      await restrict({ steamIds: [PICKED] });

      const sync = await access.forSync(serverId, [PICKED, STRANGER]);

      expect(sync.restricted).toBe(true);
      expect(sync.denied).toEqual([STRANGER]);
    });

    // An event ending changes who is allowed without anything being saved,
    // so the version has to follow the resolved list, not the last write.
    it("changes version when the allowed players change, and only then", async () => {
      const running = await event(
        { starts: "-1 hour", ends: "1 hour" },
        { players: [EVENT_PLAYER] },
      );
      await restrict({ eventIds: [running] });

      const before = (await access.forSync(serverId, [])).version;
      expect((await access.forSync(serverId, [])).version).toEqual(before);

      await postgres.query(
        `UPDATE events SET ends_at = now() - interval '1 minute' WHERE id = $1`,
        [running],
      );

      expect((await access.forSync(serverId, [])).version).not.toEqual(before);
    });

    it("denies nobody on an open server", async () => {
      expect(await access.forSync(serverId, [STRANGER])).toEqual({
        restricted: false,
        version: "open",
        denied: [],
        message: null,
      });
    });
  });

  describe("the connect info the panel shows", () => {
    it("hides a restricted server from guests and players who are not allowed", async () => {
      await restrict({ steamIds: [PICKED] });

      expect(await connectionFor(guest)).toBeNull();
      expect(await connectionFor(user(STRANGER))).toBeNull();
    });

    it("shows it to allowed players and staff", async () => {
      const running = await event(
        { starts: "-1 hour", ends: "1 hour" },
        { players: [EVENT_PLAYER] },
      );
      await restrict({
        steamIds: [PICKED],
        minRole: "verified_user",
        eventIds: [running],
      });

      for (const session of [
        user(PICKED),
        user(VERIFIED, "verified_user"),
        user(EVENT_PLAYER),
        user(MODERATOR, "moderator"),
      ]) {
        expect(await connectionFor(session)).toEqual("connect 10.0.0.1:27015");
      }
    });

    it("shows an open server to everyone", async () => {
      expect(await connectionFor(guest)).toEqual("connect 10.0.0.1:27015");
    });
  });

  describe("saving", () => {
    it("replaces the rules and tells the plugin to resync", async () => {
      await restrict({ steamIds: [PICKED, STRANGER] });
      await config.setAccess(serverId, {
        restricted: true,
        minRole: null,
        steamIds: [PICKED],
        eventIds: [],
      });

      expect(await allowed()).not.toContain(STRANGER);
      expect(rconSend).toHaveBeenLastCalledWith("player_management_refresh");
    });

    it("opens the server again when unrestricted", async () => {
      await restrict({ steamIds: [PICKED] });
      await config.setAccess(serverId, {
        restricted: false,
        minRole: null,
        steamIds: [],
        eventIds: [],
      });

      expect((await access.allowlist(serverId)).restricted).toBe(false);
      expect(await connectionFor(guest)).toEqual("connect 10.0.0.1:27015");
    });

    it("refuses Ranked and CS:GO servers", async () => {
      await postgres.query(`UPDATE servers SET type = 'Ranked' WHERE id = $1`, [
        serverId,
      ]);
      await expect(restrict()).rejects.toThrow(/Ranked servers/);

      await postgres.query(
        `UPDATE servers SET type = 'Casual', game = 'csgo' WHERE id = $1`,
        [serverId],
      );
      await expect(restrict()).rejects.toThrow(/CS2 only/);
    });
  });
});
