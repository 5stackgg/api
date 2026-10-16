import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures, MatchRow } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The friends list asks is_in_another_match and live_lineup of every friend on
// every refresh, so both must answer from the panel's few active matches
// rather than from how many matches the friend has ever played.
describe("friends list live state", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let poolId: string;

  beforeAll(async () => {
    db = await bootMigratedDb("FriendsLiveStateTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199300000000n);
    await fx.region();
    poolId = (await fx.mapPool(1)).poolId;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const matchIn = async (
    status?: string,
  ): Promise<MatchRow & { options_id: string }> => {
    const match = await fx.match({ bestOf: 1, mapPoolId: poolId });
    if (status) {
      await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
        match.id,
        status,
      ]);
    }
    return match;
  };

  const inAnotherMatch = async (steam: string) => {
    const [row] = await postgres.query<Array<{ v: boolean }>>(
      "SELECT is_in_another_match(p) AS v FROM players p WHERE steam_id = $1",
      [steam],
    );
    return row.v;
  };

  const liveLineup = async (steam: string) =>
    (
      await postgres.query<Array<{ id: string }>>(
        "SELECT l.id FROM players p CROSS JOIN LATERAL get_player_live_lineup(p) l WHERE p.steam_id = $1 ORDER BY l.id",
        [steam],
      )
    ).map(({ id }) => id);

  // What the friends subscription asked of player_lineup before: rows whose
  // lineup's match is Live.
  const liveLineupThroughTheMatch = async (steam: string) =>
    (
      await postgres.query<Array<{ id: string }>>(
        `SELECT mlp.id
           FROM match_lineup_players mlp
           JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
           JOIN matches m ON m.id = ml.match_id
          WHERE mlp.steam_id = $1 AND m.status = 'Live'
          ORDER BY mlp.id`,
        [steam],
      )
    ).map(({ id }) => id);

  describe("is_in_another_match", () => {
    it.each([
      ["Veto", true],
      ["WaitingForCheckIn", true],
      ["WaitingForServer", true],
      ["Live", true],
      ["Canceled", false],
      [undefined, false],
    ])("a lineup player in a %s match: %s", async (status, expected) => {
      const match = await matchIn(status);
      const player = await fx.lineupPlayer(match.lineup_1_id);

      expect(await inAnotherMatch(player)).toBe(expected);
    });

    it("counts the second lineup and nobody outside the match", async () => {
      const match = await matchIn("Live");
      const opponent = await fx.lineupPlayer(match.lineup_2_id);
      const bystander = await fx.player();

      expect(await inAnotherMatch(opponent)).toBe(true);
      expect(await inAnotherMatch(bystander)).toBe(false);
    });

    it("lets go of a player whose match is in a paused tournament", async () => {
      const inTournament = async (status: string) => {
        const match = await matchIn("Live");
        const [tournament] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
           VALUES ($1, now(), $2, $3, 'Setup') RETURNING id`,
          [fx.nextName("cup"), await fx.player(), match.options_id],
        );
        const [stage] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
           VALUES ($1, 'SingleElimination', 1, 4, 8) RETURNING id`,
          [tournament.id],
        );
        await postgres.query(
          `INSERT INTO tournament_brackets (tournament_stage_id, round, match_number, path, match_id)
           VALUES ($1, 1, 1, 'WB', $2)`,
          [stage.id, match.id],
        );
        // Pausing for real needs a launched tournament; only the status matters.
        await postgres.transaction(async (client) => {
          await client.query("SET LOCAL session_replication_role = replica");
          await client.query(
            "UPDATE tournaments SET status = $2 WHERE id = $1",
            [tournament.id, status],
          );
        });
        return fx.lineupPlayer(match.lineup_1_id);
      };

      expect(await inAnotherMatch(await inTournament("Setup"))).toBe(true);
      expect(await inAnotherMatch(await inTournament("Paused"))).toBe(false);
    });
  });

  describe("get_player_live_lineup", () => {
    it("returns the lineup row of each Live match the player is in, as the match join does", async () => {
      const live = await matchIn("Live");
      const otherLive = await matchIn("Live");
      const veto = await matchIn("Veto");
      const player = await fx.lineupPlayer(live.lineup_1_id);
      const opponent = await fx.lineupPlayer(live.lineup_2_id);
      await fx.lineupPlayer(otherLive.lineup_2_id, player);
      const vetoing = await fx.lineupPlayer(veto.lineup_1_id);
      const idle = await fx.player();

      for (const steam of [player, opponent, vetoing, idle]) {
        expect(await liveLineup(steam)).toEqual(
          await liveLineupThroughTheMatch(steam),
        );
      }
      expect(await liveLineup(player)).toHaveLength(2);
      expect(await liveLineup(opponent)).toHaveLength(1);
      expect(await liveLineup(vetoing)).toEqual([]);
      expect(await liveLineup(idle)).toEqual([]);
    });

    it("drops the row once the match leaves Live", async () => {
      const match = await matchIn("Live");
      const player = await fx.lineupPlayer(match.lineup_1_id);
      expect(await liveLineup(player)).toHaveLength(1);

      await postgres.query(
        "UPDATE matches SET status = 'Canceled' WHERE id = $1",
        [match.id],
      );

      expect(await liveLineup(player)).toEqual([]);
    });
  });

  describe("cost", () => {
    // Shared buffers one call reads with the plan Hasura's prepared statements
    // settle on: the cached generic plan, not one planned for this player.
    const buffersFor = (sql: string, steam: string) =>
      postgres.transaction(async (client) => {
        await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
        const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
        for (let i = 0; i < 6; i++) {
          await client.query(explain, [steam]);
        }
        const { rows } = await client.query(explain, [steam]);
        const plan = rows[0]["QUERY PLAN"][0].Plan;
        return plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
      });

    const withHistory = async (matches: number) => {
      const steam = await fx.player();
      for (let i = 0; i < matches; i++) {
        const { matchId } = await fx.bareMatch(new Date().toISOString());
        const [match] = await postgres.query<Array<{ lineup_1_id: string }>>(
          "SELECT lineup_1_id FROM matches WHERE id = $1",
          [matchId],
        );
        await fx.lineupPlayer(match.lineup_1_id, steam);
      }
      return steam;
    };

    it("does not grow with the number of matches a player has played", async () => {
      for (const status of ["Live", "Live", "Veto", "WaitingForServer"]) {
        const match = await matchIn(status);
        await fx.lineupPlayer(match.lineup_1_id);
      }
      const veteran = await withHistory(150);
      const newcomer = await withHistory(1);

      for (const sql of [
        "SELECT is_in_another_match(p) FROM players p WHERE steam_id = $1",
        "SELECT (SELECT count(*) FROM get_player_live_lineup(p)) FROM players p WHERE steam_id = $1",
      ]) {
        const veteranBuffers = await buffersFor(sql, veteran);
        const newcomerBuffers = await buffersFor(sql, newcomer);
        expect(veteranBuffers - newcomerBuffers).toBeLessThanOrEqual(10);
      }
    }, 120_000);
  });
});
