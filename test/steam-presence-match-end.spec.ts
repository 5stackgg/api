import { PostgresService } from "../src/postgres/postgres.service";
import { SteamPresenceService } from "../src/steam-presence/steam-presence.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

describe("steam presence: was a finished match played on 5stack", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let serverId: string;
  let presence: SteamPresenceService;

  beforeAll(async () => {
    db = await bootMigratedDb("SteamPresenceMatchEndTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199420000000n);
    await seedRegionWithServer(postgres, "TestPresenceMatchEnd");
    const [server] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM servers WHERE region = 'TestPresenceMatchEnd'",
    );
    serverId = server.id;
    presence = new SteamPresenceService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      { get: () => ({}) } as never,
      {} as never,
      postgres,
      {} as never,
      {} as never,
      {} as never,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const playedOnFiveStack = (steamId: string): Promise<boolean> =>
    presence["playedOnFiveStack"](steamId);

  const agoText = async (ago: string): Promise<string> => {
    const [row] = await postgres.query<Array<{ at: string }>>(
      "SELECT (now() - $1::interval)::text AS at",
      [ago],
    );
    return row.at;
  };

  const playerOnMatch = async (
    endedAgo: string,
    source = "5stack",
  ): Promise<string> => {
    const { matchId } = await fx.bareMatch(await agoText(endedAgo));
    const [match] = await postgres.query<Array<{ lineup_1_id: string }>>(
      "SELECT lineup_1_id FROM matches WHERE id = $1",
      [matchId],
    );
    if (source !== "5stack") {
      await postgres.query("UPDATE matches SET source = $2 WHERE id = $1", [
        matchId,
        source,
      ]);
    }
    return fx.lineupPlayer(match.lineup_1_id);
  };

  const playerOnUnfinishedMatch = async (
    status: string,
  ): Promise<{ steamId: string; matchId: string }> => {
    const { matchId } = await fx.bareMatch(null);
    const [match] = await postgres.query<Array<{ lineup_1_id: string }>>(
      "SELECT lineup_1_id FROM matches WHERE id = $1",
      [matchId],
    );
    const steamId = await fx.lineupPlayer(match.lineup_1_id);
    await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
      matchId,
      status,
    ]);
    const [row] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM matches WHERE id = $1",
      [matchId],
    );
    expect(row.status).toBe(status);
    return { steamId, matchId };
  };

  const playerOnServer = async (endedAgo: string | null): Promise<string> => {
    const steamId = await fx.player();
    await postgres.query(
      `INSERT INTO server_player_sessions
         (server_id, player_steam_id, started_at, ended_at)
       VALUES ($1, $2::bigint, now() - interval '40 minutes', $3::timestamptz)`,
      [serverId, steamId, endedAgo ? await agoText(endedAgo) : null],
    );
    return steamId;
  };

  it("counts a 5stack match that ended a couple of minutes ago", async () => {
    const steamId = await playerOnMatch("2 minutes");

    await expect(playedOnFiveStack(steamId)).resolves.toBe(true);
  });

  it("ignores a 5stack match that ended well before", async () => {
    const steamId = await playerOnMatch("30 minutes");

    await expect(playedOnFiveStack(steamId)).resolves.toBe(false);
  });

  it("ignores an imported Valve match", async () => {
    const steamId = await playerOnMatch("2 minutes", "valve");

    await expect(playedOnFiveStack(steamId)).resolves.toBe(false);
  });

  it("counts a 5stack match that is live right now", async () => {
    const { steamId } = await playerOnUnfinishedMatch("Live");

    await expect(playedOnFiveStack(steamId)).resolves.toBe(true);
  });

  it("ignores a 5stack match left Live for hours", async () => {
    const { steamId, matchId } = await playerOnUnfinishedMatch("Live");
    await postgres.query(
      "UPDATE matches SET started_at = now() - interval '8 hours' WHERE id = $1",
      [matchId],
    );

    await expect(playedOnFiveStack(steamId)).resolves.toBe(false);
  });

  it("ignores a 5stack match still waiting for a server", async () => {
    const { steamId } = await playerOnUnfinishedMatch("WaitingForServer");

    await expect(playedOnFiveStack(steamId)).resolves.toBe(false);
  });

  it("counts a 5stack server session that closed a few minutes ago", async () => {
    const steamId = await playerOnServer("4 minutes");

    await expect(playedOnFiveStack(steamId)).resolves.toBe(true);
  });

  it("counts a player still connected to a 5stack server", async () => {
    const steamId = await playerOnServer(null);

    await expect(playedOnFiveStack(steamId)).resolves.toBe(true);
  });

  it("ignores a 5stack server session that closed well before", async () => {
    const steamId = await playerOnServer("30 minutes");

    await expect(playedOnFiveStack(steamId)).resolves.toBe(false);
  });

  it("ignores a player with no 5stack games at all", async () => {
    const steamId = await fx.player();

    await expect(playedOnFiveStack(steamId)).resolves.toBe(false);
  });
});
