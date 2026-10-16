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
  // lineup's match is Live and visible, and the matches permissions hide
  // practice sessions from every role.
  const liveLineupThroughTheMatch = async (steam: string) =>
    (
      await postgres.query<Array<{ id: string }>>(
        `SELECT mlp.id
           FROM match_lineup_players mlp
           JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
           JOIN matches m ON m.id = ml.match_id
          WHERE mlp.steam_id = $1 AND m.status = 'Live' AND m.source <> 'practice'
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

    it("keeps a practice session out, as the matches permissions do", async () => {
      const match = await matchIn("Live");
      const player = await fx.lineupPlayer(match.lineup_1_id);
      await postgres.query(
        "UPDATE matches SET source = 'practice' WHERE id = $1",
        [match.id],
      );

      expect(await liveLineup(player)).toEqual([]);
      expect(await liveLineupThroughTheMatch(player)).toEqual([]);
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

    const FUNCTIONS = [
      "SELECT is_in_another_match(p) FROM players p WHERE steam_id = $1",
      "SELECT (SELECT count(*) FROM get_player_live_lineup(p)) FROM players p WHERE steam_id = $1",
    ];

    const activeMatches = async () => {
      for (const status of [
        "Live",
        "Live",
        "Live",
        "Veto",
        "WaitingForServer",
        "Live",
        "Veto",
        "Live",
      ]) {
        const match = await matchIn(status);
        await fx.lineupPlayer(match.lineup_1_id);
      }
    };

    const extraBuffers = async (veteran: string, newcomer: string) => {
      const extra: Record<string, number> = {};
      for (const sql of FUNCTIONS) {
        extra[sql] =
          (await buffersFor(sql, veteran)) - (await buffersFor(sql, newcomer));
      }
      return extra;
    };

    it("does not grow with the number of matches a player has played", async () => {
      await activeMatches();
      const veteran = await withHistory(150);
      const newcomer = await withHistory(1);

      for (const extra of Object.values(
        await extraBuffers(veteran, newcomer),
      )) {
        expect(extra).toBeLessThanOrEqual(10);
      }
    }, 120_000);

    // An import-heavy panel: most players appear in one lineup, so the planner
    // rates a lookup on steam_id alone as just as selective as the unique key.
    it("does not grow with history spread among one-off players", async () => {
      await activeMatches();
      const veteran = await fx.player();
      const newcomer = await withHistory(1);
      await postgres.transaction(async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `INSERT INTO players (steam_id, name, role)
           SELECT 76561199390000000 + g, 'one-off ' || g, 'user' FROM generate_series(1, 6000) g`,
        );
        await client.query(
          `CREATE TEMP TABLE one_off_lineups AS
           SELECT g, gen_random_uuid() AS id FROM generate_series(1, 6150) g`,
        );
        await client.query(
          "INSERT INTO match_lineups (id) SELECT id FROM one_off_lineups ORDER BY g",
        );
        await client.query(
          `INSERT INTO match_lineup_players (match_lineup_id, steam_id)
           SELECT id, CASE WHEN g % 41 = 0 THEN $1::bigint ELSE 76561199390000000 + g - g / 41 END
             FROM one_off_lineups ORDER BY g`,
          [veteran],
        );
      });
      await postgres.query("VACUUM ANALYZE match_lineup_players");
      // Equally cheap indexes are tried newest first, so rebuild them all
      // rather than let the fixture's build order pick the winner.
      await postgres.query("REINDEX TABLE CONCURRENTLY match_lineup_players");

      for (const extra of Object.values(
        await extraBuffers(veteran, newcomer),
      )) {
        expect(extra).toBeLessThanOrEqual(10);
      }
    }, 120_000);

    // The planner prices a steam_id-only index the same as the unique key for
    // a (match_lineup_id, steam_id) probe; whenever it wins that tie the probe
    // reads the player's whole history.
    it("keeps no index on match_lineup_players.steam_id alone", async () => {
      const indexes = await postgres.query<Array<{ indexname: string }>>(
        `SELECT i.relname AS indexname
           FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = 'public.match_lineup_players'::regclass
            AND x.indnkeyatts = 1
            AND x.indkey[0] = (SELECT attnum FROM pg_attribute
                                WHERE attrelid = 'public.match_lineup_players'::regclass
                                  AND attname = 'steam_id')`,
      );
      expect(indexes).toEqual([]);
    });

    it("does not grow with the panel's finished or far-off scheduled matches", async () => {
      await activeMatches();
      const player = await withHistory(1);
      const before = await Promise.all(
        FUNCTIONS.map((sql) => buffersFor(sql, player)),
      );

      const added: Array<string> = [];
      for (let i = 0; i < 400; i++) {
        added.push((await fx.bareMatch(new Date().toISOString())).matchId);
      }
      // Only the statuses matter here, not the transitions that lead to them.
      await postgres.transaction(async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `UPDATE matches SET status = 'Scheduled', scheduled_at = now() + interval '7 days'
            WHERE id = ANY($1::uuid[])`,
          [added.slice(0, 200)],
        );
        await client.query(
          "UPDATE matches SET status = 'Finished' WHERE id = ANY($1::uuid[])",
          [added.slice(200)],
        );
      });
      await postgres.query("VACUUM ANALYZE matches");

      const after = await Promise.all(
        FUNCTIONS.map((sql) => buffersFor(sql, player)),
      );
      const growth = FUNCTIONS.map((sql, i) => ({
        sql,
        buffers: after[i] - before[i],
      }));
      expect(growth.filter(({ buffers }) => buffers > 10)).toEqual([]);
    }, 120_000);
  });
});
