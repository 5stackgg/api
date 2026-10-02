import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// assign_lobby_parties: 5stack parties are derived in the database from the
// lobby, with no API involvement — and must never overwrite a party the
// importer already resolved from Valve/FACEIT.
describe("lobby parties trigger (SQL-driven)", () => {
  let db: SqlTestDb;
  let pg: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("LobbyPartiesTest");
    pg = db.postgres;
    fx = new Fixtures(pg, 76561199500000000n);
    await seedRegionWithServer(pg, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  // tai_lobbies reads the creator off the Hasura session and enrolls them as
  // the accepted captain, so the lobby has to be created as a user.
  const newLobby = async (steamIds: string[]) => {
    const [creator, ...rest] = steamIds;
    const lobbyId = await runAsUser(pg, creator, "user", async (query) => {
      const [row] = (await query(
        "INSERT INTO lobbies (access) VALUES ('Private') RETURNING id",
      )) as Array<{ id: string }>;
      return row.id;
    });

    for (const steamId of rest) {
      await pg.query(
        `INSERT INTO lobby_players (lobby_id, steam_id, status)
         VALUES ($1, $2, 'Accepted')
         ON CONFLICT (steam_id, lobby_id) DO UPDATE SET status = 'Accepted'`,
        [lobbyId, steamId],
      );
    }
    return lobbyId;
  };

  const partiesOf = (matchId: string) =>
    pg.query<
      Array<{
        steam_id: string;
        party_id: string | null;
        party_source: string | null;
      }>
    >(
      `SELECT mlp.steam_id::text AS steam_id, mlp.party_id::text AS party_id, mlp.party_source
         FROM match_lineup_players mlp
         JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE ml.match_id = $1::uuid
        ORDER BY mlp.steam_id`,
      [matchId],
    );

  const lineupsFor = async (matchId: string) =>
    (
      await pg.query<Array<{ id: string }>>(
        `SELECT id FROM match_lineups WHERE match_id = $1 ORDER BY id`,
        [matchId],
      )
    ).map((r) => r.id);

  const setSource = (matchId: string, source: string) =>
    pg.query(`UPDATE matches SET source = $2 WHERE id = $1::uuid`, [
      matchId,
      source,
    ]);

  it("stamps the lobby on players who queued together", async () => {
    const duoA = await fx.player();
    const duoB = await fx.player();
    const solo = await fx.player();
    const lobbyId = await newLobby([duoA, duoB]);

    const { matchId } = await fx.bareMatch();
    const [lineup1] = await lineupsFor(matchId);

    // one bulk insert, the way matchmaking writes a team
    await pg.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
       SELECT $1, unnest($2::bigint[])`,
      [lineup1, [duoA, duoB, solo]],
    );

    const rows = await partiesOf(matchId);
    const byId = new Map(rows.map((r) => [r.steam_id, r]));
    expect(byId.get(duoA).party_id).toBe(lobbyId);
    expect(byId.get(duoB).party_id).toBe(lobbyId);
    expect(byId.get(duoA).party_source).toBe("lobby");
    // in no lobby -> not a party
    expect(byId.get(solo).party_id).toBeNull();
  });

  it("ignores a lobby whose other members are not in this match", async () => {
    const player = await fx.player();
    const friendElsewhere = await fx.player();
    await newLobby([player, friendElsewhere]);

    const { matchId } = await fx.bareMatch();
    const [lineup1] = await lineupsFor(matchId);
    await pg.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)`,
      [lineup1, player],
    );

    const [row] = await partiesOf(matchId);
    expect(row.party_id).toBeNull();
  });

  it("refuses to stamp a lobby on an imported match", async () => {
    // Two players who happen to share a 5stack lobby also appear in an
    // imported Valve match. Their lobby says nothing about how they queued
    // for Valve, so it must not be recorded as a party there.
    const a = await fx.player();
    const b = await fx.player();
    await newLobby([a, b]);

    const { matchId } = await fx.bareMatch();
    await setSource(matchId, "valve");
    const [lineup1] = await lineupsFor(matchId);

    await pg.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
       SELECT $1, unnest($2::bigint[])`,
      [lineup1, [a, b]],
    );

    for (const row of await partiesOf(matchId)) {
      expect(row.party_id).toBeNull();
      expect(row.party_source).toBeNull();
    }
  });

  it("never overwrites a party the importer already resolved", async () => {
    const a = await fx.player();
    const b = await fx.player();
    await newLobby([a, b]);

    const { matchId } = await fx.bareMatch();
    const [lineup1] = await lineupsFor(matchId);
    const [{ id: valveParty }] = await pg.query<Array<{ id: string }>>(
      "SELECT gen_random_uuid() AS id",
    );

    // the importer stamps valve parties in the same insert
    await pg.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id, party_id, party_source)
       VALUES ($1, $2, $3::uuid, 'valve'), ($1, $4, $3::uuid, 'valve')`,
      [lineup1, a, valveParty, b],
    );

    for (const row of await partiesOf(matchId)) {
      expect(row.party_id).toBe(valveParty);
      expect(row.party_source).toBe("valve");
    }
  });

  it("keeps one party id when a lobby is split across both lineups", async () => {
    const a = await fx.player();
    const b = await fx.player();
    const lobbyId = await newLobby([a, b]);

    const { matchId } = await fx.bareMatch();
    const [lineup1, lineup2] = await lineupsFor(matchId);

    // separate statements, the way matchmaking writes team 1 then team 2
    await pg.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)`,
      [lineup1, a],
    );
    await pg.query(
      `INSERT INTO match_lineup_players (match_lineup_id, steam_id) VALUES ($1, $2)`,
      [lineup2, b],
    );

    const rows = await partiesOf(matchId);
    expect(rows.map((r) => r.party_id)).toEqual([lobbyId, lobbyId]);
  });
});
