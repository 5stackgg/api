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

  describe("cost", () => {
    const plan = (sql: string, params: Array<unknown>) =>
      postgres.transaction(async (client) => {
        for (let i = 0; i < 3; i++) {
          await client.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
            params,
          );
        }
        const { rows } = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
          params,
        );
        return rows[0]["QUERY PLAN"][0].Plan;
      });

    const befriendMany = async (viewer: string, count: number) => {
      const others = await fx.players(count);
      await postgres.query(
        `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
         SELECT $1, unnest($2::bigint[]), 'Accepted'`,
        [viewer, others],
      );
      return others;
    };

    // Every friends-only lobby, draft, player and pick a list shows asks
    // whether one of its members is the viewer's friend.
    it("answers is_friend from the pair alone, however many friends either has", async () => {
      const [host, few, many, stranger] = await fx.players(4);
      for (const viewer of [few, many]) {
        await postgres.query(
          `INSERT INTO friends (player_steam_id, other_player_steam_id, status)
           VALUES ($1, $2, 'Accepted')`,
          [viewer, host],
        );
      }
      await befriendMany(few, 3);
      await befriendMany(many, 300);
      await befriendMany(host, 300);
      await postgres.query("VACUUM ANALYZE friends");

      const ask = async (viewer: string) => {
        const params = [
          host,
          JSON.stringify({
            "x-hasura-role": "user",
            "x-hasura-user-id": viewer,
          }),
        ];
        const [{ is_friend }] = await postgres.query<
          Array<{ is_friend: boolean }>
        >(
          "SELECT is_friend(p, $2::json) AS is_friend FROM players p WHERE p.steam_id = $1",
          params,
        );
        const root = await plan(
          "SELECT is_friend(p, $2::json) FROM players p WHERE p.steam_id = $1",
          params,
        );
        return {
          is_friend,
          buffers: root["Shared Hit Blocks"] + root["Shared Read Blocks"],
        };
      };

      const [a, b, c] = [await ask(few), await ask(many), await ask(stranger)];
      expect([a.is_friend, b.is_friend, c.is_friend]).toEqual([
        true,
        true,
        false,
      ]);
      expect(b.buffers - a.buffers).toBeLessThanOrEqual(2);
      expect(a.buffers).toBeLessThanOrEqual(12);
    }, 120_000);

    // A friend's in-match state comes from one read of the matches in play for
    // the whole list, not one per friend.
    it("reads the matches in play once for a whole friends list", async () => {
      const [viewer] = await fx.players(1);
      const friends = await befriendMany(viewer, 30);
      const { poolId } = await fx.mapPool(1);
      for (let i = 0; i < 6; i++) {
        const match = await fx.match({ bestOf: 1, mapPoolId: poolId });
        await fx.lineupPlayer(match.lineup_1_id, friends[i]);
        await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
          match.id,
          i % 2 ? "Live" : "Veto",
        ]);
      }

      const root = await plan(
        `SELECT f.steam_id, f.is_in_another_match FROM v_my_friends f
          WHERE f.friend_steam_id = $1`,
        [viewer],
      );
      const scans: Array<{ loops: number }> = [];
      const walk = (node: Record<string, any>) => {
        if (node["Relation Name"] === "matches") {
          scans.push({ loops: node["Actual Loops"] });
        }
        (node.Plans ?? []).forEach(walk);
      };
      walk(root);

      expect(root["Actual Rows"]).toBe(30);
      expect(scans.length).toBeGreaterThan(0);
      expect(scans.filter(({ loops }) => loops > 1)).toEqual([]);
    }, 120_000);
  });
});
