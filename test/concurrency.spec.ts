import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

type PoolClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
};

// Exercises the concurrency claims in the SQL: verify_map_veto_pick and
// assign_team_to_bracket_slot both take row locks (FOR UPDATE) so simultaneous
// writers serialize instead of double-applying. These tests race two real
// connections against each other.
describe("concurrency (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  const pool = () =>
    (
      postgres as unknown as {
        pool: { connect(): Promise<PoolClient> };
      }
    ).pool;

  beforeAll(async () => {
    db = await bootMigratedDb("ConcurrencyTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199970000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  it("simultaneous veto picks serialize: exactly one Ban lands per turn", async () => {
    const { poolId, mapIds } = await fx.mapPool(3);
    const match = await fx.match({ mapVeto: true, mapPoolId: poolId });
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]); // redirected to Veto

    // Two clients race the same first-turn Ban with different maps.
    const clientA = await pool().connect();
    const clientB = await pool().connect();
    try {
      const results = await Promise.allSettled([
        clientA.query(
          `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
           VALUES ($1, 'Ban', $2, $3)`,
          [match.id, match.lineup_1_id, mapIds[0]],
        ),
        clientB.query(
          `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
           VALUES ($1, 'Ban', $2, $3)`,
          [match.id, match.lineup_1_id, mapIds[1]],
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter(
        (r) => r.status === "rejected",
      ) as Array<PromiseRejectedResult>;
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      // The loser sees the advanced turn, not a corrupted state.
      expect(String(rejected[0].reason)).toMatch(/Expected other lineup/i);

      const picks = await postgres.query<Array<{ type: string }>>(
        "SELECT type FROM match_map_veto_picks WHERE match_id = $1",
        [match.id],
      );
      expect(picks.length).toBe(1);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it("simultaneous semifinal results both land in the final, in distinct slots", async () => {
    const t = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    const semis = (await tfx.getBrackets(t.stageIds[0])).filter(
      (b) => b.round === 1,
    );

    const clientA = await pool().connect();
    const clientB = await pool().connect();
    try {
      const results = await Promise.allSettled([
        clientA.query(
          "UPDATE matches SET winning_lineup_id = lineup_1_id WHERE id = $1",
          [semis[0].match_id],
        ),
        clientB.query(
          "UPDATE matches SET winning_lineup_id = lineup_2_id WHERE id = $1",
          [semis[1].match_id],
        ),
      ]);
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      expect(failures.map((f) => String(f.reason))).toEqual([]);
    } finally {
      clientA.release();
      clientB.release();
    }

    const final = (await tfx.getBrackets(t.stageIds[0])).find(
      (b) => b.round === 2,
    )!;
    // Both winners present, in different slots, with a match scheduled — the
    // exact invariant the grand-final slot collision violated.
    expect(final.tournament_team_id_1).toBe(semis[0].tournament_team_id_1);
    expect(final.tournament_team_id_2).toBe(semis[1].tournament_team_id_2);
    expect(final.match_id).not.toBeNull();
  });

  it("racing the same waitlist promotion never over-fills a draft", async () => {
    const host = await fx.player();
    const [draft] = await postgres.query<
      Array<{ id: string; capacity: number }>
    >(
      `INSERT INTO draft_games (host_steam_id, type) VALUES ($1, 'Wingman') RETURNING id, capacity`,
      [host],
    );
    // Fill to capacity, then two waitlisted players.
    const members: Array<string> = [];
    for (let i = 0; i < Number(draft.capacity); i++) {
      const p = await fx.player();
      members.push(p);
      await postgres.query(
        `INSERT INTO draft_game_players (draft_game_id, steam_id, status) VALUES ($1, $2, 'Accepted')`,
        [draft.id, p],
      );
    }
    for (let i = 0; i < 2; i++) {
      await postgres.query(
        `INSERT INTO draft_game_players (draft_game_id, steam_id, status) VALUES ($1, $2, 'Waitlist')`,
        [draft.id, await fx.player()],
      );
    }

    // Two accepted members leave at the same moment.
    const clientA = await pool().connect();
    const clientB = await pool().connect();
    try {
      await Promise.allSettled([
        clientA.query(
          "DELETE FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
          [draft.id, members[0]],
        ),
        clientB.query(
          "DELETE FROM draft_game_players WHERE draft_game_id = $1 AND steam_id = $2",
          [draft.id, members[1]],
        ),
      ]);
    } finally {
      clientA.release();
      clientB.release();
    }

    const [counts] = await postgres.query<
      Array<{ accepted: string; waitlisted: string }>
    >(
      `SELECT count(*) FILTER (WHERE status = 'Accepted') AS accepted,
              count(*) FILTER (WHERE status = 'Waitlist') AS waitlisted
       FROM draft_game_players WHERE draft_game_id = $1`,
      [draft.id],
    );
    expect(Number(counts.accepted)).toBe(Number(draft.capacity));
    expect(Number(counts.waitlisted)).toBe(0);
  });
});
