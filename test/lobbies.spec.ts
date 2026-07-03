import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Exercises the lobby triggers: creator bootstrap (tai_lobbies), single-lobby
// membership on accept (taiu_lobby_players), and captain succession / lobby
// teardown on leave (tad_lobby_players).
describe("lobbies (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let seq = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("LobbiesTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM lobbies");
    await postgres.query("DELETE FROM players");
  });

  const nextSteam = () => (76561199100000000n + BigInt(++seq)).toString();

  const seedPlayer = async () => {
    const steam = nextSteam();
    await postgres.query(
      "INSERT INTO players (steam_id, name) VALUES ($1, $2)",
      [steam, `p${seq}`],
    );
    return steam;
  };

  // Lobby creation reads the creator from the Hasura session.
  const createLobby = async (creator: string) =>
    runAsUser(postgres, creator, "user", async (query) => {
      const [row] = (await query(
        "INSERT INTO lobbies (access) VALUES ('Private') RETURNING id",
      )) as Array<{ id: string }>;
      return row.id;
    });

  const lobbyPlayers = (lobbyId: string) =>
    postgres.query<
      Array<{ steam_id: string; captain: boolean; status: string }>
    >(
      "SELECT steam_id, captain, status FROM lobby_players WHERE lobby_id = $1 ORDER BY steam_id",
      [lobbyId],
    );

  const invite = (lobbyId: string, steam: string) =>
    postgres.query(
      "INSERT INTO lobby_players (lobby_id, steam_id, status) VALUES ($1, $2, 'Invited')",
      [lobbyId, steam],
    );

  const accept = (lobbyId: string, steam: string) =>
    postgres.query(
      "UPDATE lobby_players SET status = 'Accepted' WHERE lobby_id = $1 AND steam_id = $2",
      [lobbyId, steam],
    );

  const leave = (lobbyId: string, steam: string) =>
    postgres.query(
      "DELETE FROM lobby_players WHERE lobby_id = $1 AND steam_id = $2",
      [lobbyId, steam],
    );

  it("creating a lobby enrolls the creator as accepted captain", async () => {
    const creator = await seedPlayer();
    const lobbyId = await createLobby(creator);

    const players = await lobbyPlayers(lobbyId);
    expect(players).toEqual([
      { steam_id: creator, captain: true, status: "Accepted" },
    ]);
  });

  it("accepting an invite pulls the player out of every other lobby", async () => {
    const creatorA = await seedPlayer();
    const creatorB = await seedPlayer();
    const drifter = await seedPlayer();
    const lobbyA = await createLobby(creatorA);
    const lobbyB = await createLobby(creatorB);

    await invite(lobbyA, drifter);
    await accept(lobbyA, drifter);

    await invite(lobbyB, drifter);
    await accept(lobbyB, drifter);

    expect(
      (await lobbyPlayers(lobbyA)).map((p) => p.steam_id),
    ).not.toContain(drifter);
    expect((await lobbyPlayers(lobbyB)).map((p) => p.steam_id)).toContain(
      drifter,
    );
  });

  it("the captain leaving promotes the next accepted player", async () => {
    const creator = await seedPlayer();
    const mate = await seedPlayer();
    const lobbyId = await createLobby(creator);
    await invite(lobbyId, mate);
    await accept(lobbyId, mate);

    await leave(lobbyId, creator);

    const players = await lobbyPlayers(lobbyId);
    expect(players.length).toBe(1);
    expect(players[0].steam_id).toBe(mate);
    expect(players[0].captain).toBe(true);
  });

  it("the last accepted player leaving dissolves the lobby", async () => {
    const creator = await seedPlayer();
    const lobbyId = await createLobby(creator);

    await leave(lobbyId, creator);

    const lobbies = await postgres.query<Array<unknown>>(
      "SELECT 1 FROM lobbies WHERE id = $1",
      [lobbyId],
    );
    expect(lobbies.length).toBe(0);
  });

  it("a pending invitee leaving does not dethrone the captain", async () => {
    const creator = await seedPlayer();
    const invitee = await seedPlayer();
    const lobbyId = await createLobby(creator);
    await invite(lobbyId, invitee);

    await leave(lobbyId, invitee);

    const players = await lobbyPlayers(lobbyId);
    expect(players).toEqual([
      { steam_id: creator, captain: true, status: "Accepted" },
    ]);
  });
});
