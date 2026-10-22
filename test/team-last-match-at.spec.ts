import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { HasuraPermissions } from "./utils/hasura-permissions";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// teams.last_match_at as the directory reads it: the latest of each started
// match's end (or start, while it is still going) across every lineup the team
// played as. Read through the compiled guest select, so it holds whether the
// field is computed on read or stored.
describe("teams.last_match_at", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let permissions: HasuraPermissions;

  beforeAll(async () => {
    db = await bootMigratedDb("TeamLastMatchAtTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199730000000n);
    await fx.region();
    permissions = new HasuraPermissions(postgres);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function lastMatchAt(teamId: string): Promise<string | null> {
    const params: Array<unknown> = [];
    const sql = await permissions.select(
      "teams",
      "t",
      { role: "guest", userId: "0" },
      { fields: ["last_match_at"], where: { id: { _eq: teamId } } },
      params,
    );
    const [row] = await postgres.query<Array<{ last_match_at: Date | null }>>(
      sql,
      params as Array<string>,
    );
    return row.last_match_at ? row.last_match_at.toISOString() : null;
  }

  async function match(): Promise<{ id: string; l1: string; l2: string }> {
    const { matchId } = await fx.bareMatch();
    const [row] = await postgres.query<
      Array<{ lineup_1_id: string; lineup_2_id: string }>
    >("SELECT lineup_1_id, lineup_2_id FROM matches WHERE id = $1", [matchId]);
    return { id: matchId, l1: row.lineup_1_id, l2: row.lineup_2_id };
  }

  const setTeam = (lineupId: string, teamId: string | null) =>
    postgres.query("UPDATE match_lineups SET team_id = $2 WHERE id = $1", [
      lineupId,
      teamId,
    ]);

  const setTimes = (
    matchId: string,
    startedAt: string | null,
    endedAt: string | null,
  ) =>
    postgres.query(
      "UPDATE matches SET started_at = $2, ended_at = $3 WHERE id = $1",
      [matchId, startedAt, endedAt],
    );

  it("follows a team's matches as they start, end, move and go away", async () => {
    const one = await fx.team();
    const two = await fx.team();

    expect(await lastMatchAt(one.id)).toBeNull();

    const first = await match();
    await setTeam(first.l1, one.id);
    expect(await lastMatchAt(one.id)).toBeNull();

    await setTimes(first.id, "2026-05-01T10:00:00.000Z", null);
    expect(await lastMatchAt(one.id)).toBe("2026-05-01T10:00:00.000Z");

    await setTimes(
      first.id,
      "2026-05-01T10:00:00.000Z",
      "2026-05-01T10:40:00.000Z",
    );
    expect(await lastMatchAt(one.id)).toBe("2026-05-01T10:40:00.000Z");

    const second = await match();
    await setTeam(second.l2, one.id);
    await setTimes(second.id, "2026-04-01T10:00:00.000Z", null);
    expect(await lastMatchAt(one.id)).toBe("2026-05-01T10:40:00.000Z");

    await setTimes(second.id, "2026-06-01T10:00:00.000Z", null);
    expect(await lastMatchAt(one.id)).toBe("2026-06-01T10:00:00.000Z");

    await setTeam(second.l2, two.id);
    expect(await lastMatchAt(one.id)).toBe("2026-05-01T10:40:00.000Z");
    expect(await lastMatchAt(two.id)).toBe("2026-06-01T10:00:00.000Z");

    await setTimes(first.id, null, "2026-05-01T10:40:00.000Z");
    expect(await lastMatchAt(one.id)).toBeNull();

    await postgres.query("DELETE FROM matches WHERE id = $1", [second.id]);
    expect(await lastMatchAt(two.id)).toBeNull();
  });

  it("counts a match that arrives already played", async () => {
    const team = await fx.team();
    const [l1] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups (team_id) VALUES ($1) RETURNING id",
      [team.id],
    );
    const [l2] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
    );
    await postgres.query(
      `INSERT INTO matches (lineup_1_id, lineup_2_id, source, started_at, ended_at)
       VALUES ($1, $2, '5stack', '2026-07-01T10:00:00Z', '2026-07-01T10:45:00Z')`,
      [l1.id, l2.id],
    );
    expect(await lastMatchAt(team.id)).toBe("2026-07-01T10:45:00.000Z");
  });

  it("is the same for every team as the definition it replaced", async () => {
    const teams = [await fx.team(), await fx.team(), await fx.team()];
    const times: Array<[string | null, string | null]> = [
      ["2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z"],
      ["2026-02-01T00:00:00Z", null],
      [null, null],
      [null, "2026-03-01T00:00:00Z"],
      ["2026-01-15T00:00:00Z", "2026-01-15T01:00:00Z"],
    ];
    let i = 0;
    for (const [startedAt, endedAt] of times) {
      const m = await match();
      await setTeam(m.l1, teams[i % 3].id);
      await setTeam(m.l2, teams[(i + 1) % 3].id);
      await setTimes(m.id, startedAt, endedAt);
      i++;
    }

    for (const team of teams) {
      const [reference] = await postgres.query<Array<{ at: Date | null }>>(
        `SELECT max(COALESCE(m.ended_at, m.started_at)) AS at
           FROM match_lineups ml
           JOIN matches m ON m.id = ml.match_id
          WHERE ml.team_id = $1 AND m.started_at IS NOT NULL`,
        [team.id],
      );
      expect(await lastMatchAt(team.id)).toBe(
        reference.at ? reference.at.toISOString() : null,
      );
    }
  });
});
