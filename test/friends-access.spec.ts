import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { HasuraPermissions } from "./utils/hasura-permissions";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Pins who sees a lobby or draft of each access, and its players and picks,
// so how "is a friend of a member" is answered can change without anyone
// seeing more or less.
describe("friends-only lobbies and drafts", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let viewers: Record<string, string>;
  const names: Record<string, string> = {};

  const ACCESS = ["Open", "Friends", "Invite", "Private"];
  const TABLES = [
    "lobbies",
    "lobby_players",
    "draft_games",
    "draft_game_players",
    "draft_game_picks",
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("FriendsAccessTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199730000000n);
    await fx.region();

    const [acceptedOut, acceptedIn, pendingOut, pendingIn, memberFriend] =
      await fx.players(5);
    const stranger = await fx.player();
    viewers = {
      acceptedOut,
      acceptedIn,
      pendingOut,
      pendingIn,
      memberFriend,
      stranger,
    };

    const befriend = (a: string, b: string, status: string) =>
      postgres.query(
        `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
         VALUES ($1, $2, $3)`,
        [a, b, status],
      );

    for (const access of ACCESS) {
      const [host, member] = await fx.players(2);
      await befriend(acceptedOut, host, "Accepted");
      await befriend(host, acceptedIn, "Accepted");
      await befriend(pendingOut, host, "Pending");
      await befriend(host, pendingIn, "Pending");
      await befriend(member, memberFriend, "Accepted");

      // Creating a lobby seats its creator, read from the Hasura session.
      const lobbyId = await runAsUser(postgres, host, "user", async (query) => {
        const [row] = (await query(
          "INSERT INTO lobbies (access) VALUES ($1) RETURNING id",
          [access],
        )) as Array<{ id: string }>;
        return row.id;
      });
      names[lobbyId] = `lobby ${access}`;
      await postgres.query(
        `INSERT INTO lobby_players (lobby_id, steam_id, status)
         VALUES ($1, $2, 'Accepted')`,
        [lobbyId, member],
      );

      const [draft] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO draft_games (host_steam_id, type, access)
         VALUES ($1, 'Wingman', $2) RETURNING id`,
        [host, access],
      );
      names[draft.id] = `draft ${access}`;
      await postgres.query(
        `INSERT INTO draft_game_players (draft_game_id, steam_id, status)
         VALUES ($1, $2, 'Accepted'), ($1, $3, 'Accepted')`,
        [draft.id, host, member],
      );
      await postgres.query(
        `INSERT INTO draft_game_picks (draft_game_id, captain_steam_id, picked_steam_id, lineup)
         VALUES ($1, $2, $3, 1)`,
        [draft.id, host, member],
      );

      if (access === "Private") {
        viewers.member = member;
      }
    }
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const key: Record<string, string> = {
    lobbies: "id",
    lobby_players: "lobby_id",
    draft_games: "id",
    draft_game_players: "draft_game_id",
    draft_game_picks: "draft_game_id",
  };

  async function seen(viewer: string) {
    const permissions = new HasuraPermissions(postgres);
    const out: Record<string, Array<string>> = {};
    for (const table of TABLES) {
      const params: Array<unknown> = [];
      const where = await permissions.where(
        table,
        "select",
        "t",
        { role: "user", userId: viewer },
        params,
      );
      const rows = await postgres.transaction(async (client) => {
        await client.query("SELECT set_config('hasura.user', $1, true)", [
          JSON.stringify({
            "x-hasura-role": "user",
            "x-hasura-user-id": viewer,
          }),
        ]);
        return (
          await client.query(
            `SELECT t.${key[table]}::text AS id FROM public."${table}" t WHERE ${where}`,
            params,
          )
        ).rows as Array<{ id: string }>;
      });
      out[table] = rows
        .map((r) => names[r.id])
        .filter(Boolean)
        .sort();
    }
    return out;
  }

  const all = (kind: string, accesses: Array<string>, each = 1) =>
    accesses.flatMap((a) => Array(each).fill(`${kind} ${a}`)).sort();

  it("shows each viewer what their friendships with the members allow", async () => {
    const view = async (viewer: string) => seen(viewers[viewer]);
    const friendsOf = (accesses: Array<string>) => ({
      lobbies: all("lobby", accesses),
      lobby_players: all("lobby", accesses, 2),
      draft_games: all("draft", accesses),
      draft_game_players: all("draft", accesses, 2),
      draft_game_picks: all("draft", accesses),
    });

    const matrix: Record<string, unknown> = {};
    for (const viewer of Object.keys(viewers)) {
      matrix[viewer] = await view(viewer);
    }

    expect(matrix).toEqual({
      acceptedOut: friendsOf(["Open", "Friends"]),
      acceptedIn: friendsOf(["Open", "Friends"]),
      pendingOut: friendsOf(["Open", "Friends"]),
      pendingIn: friendsOf(["Open", "Friends"]),
      memberFriend: friendsOf(["Open", "Friends"]),
      stranger: friendsOf(["Open"]),
      member: friendsOf(["Open", "Private"]),
    });
  });
});
