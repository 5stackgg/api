import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// An event's matches page sorts on event_match_links.match_created_at, so it
// has to be the match's own creation time however the link was made.
describe("event_match_links.match_created_at", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("EventMatchLinksCreatedAtTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199740000000n);
    await fx.region();
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function event(): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO events (name, starts_at, ends_at, organizer_steam_id)
       VALUES ($1, now() - interval '30 days', NULL, $2) RETURNING id`,
      [fx.nextName("event"), await fx.player()],
    );
    return row.id;
  }

  async function teamMatch(teamId: string, createdAt: string): Promise<string> {
    const [l1] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups (team_id) VALUES ($1) RETURNING id",
      [teamId],
    );
    const [l2] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO match_lineups DEFAULT VALUES RETURNING id",
    );
    const [match] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO matches (lineup_1_id, lineup_2_id, source, created_at)
       VALUES ($1, $2, '5stack', $3) RETURNING id`,
      [l1.id, l2.id, createdAt],
    );
    return match.id;
  }

  async function links(eventId: string) {
    return postgres.query<
      Array<{ match_id: string; match_created_at: Date; created_at: Date }>
    >(
      `SELECT l.match_id, l.match_created_at, m.created_at
         FROM event_match_links l
         JOIN matches m ON m.id = l.match_id
        WHERE l.event_id = $1
        ORDER BY l.match_created_at DESC`,
      [eventId],
    );
  }

  it("carries the match's creation time when the match arrives after the team is attached", async () => {
    const eventId = await event();
    const team = await fx.team();
    await postgres.query(
      "INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)",
      [eventId, team.id],
    );

    const older = await teamMatch(
      team.id,
      new Date(Date.now() - 5 * 86400e3).toISOString(),
    );
    const newer = await teamMatch(
      team.id,
      new Date(Date.now() - 1 * 86400e3).toISOString(),
    );

    const rows = await links(eventId);
    expect(rows.map((r) => r.match_id)).toEqual([newer, older]);
    for (const row of rows) {
      expect(row.match_created_at.toISOString()).toBe(
        row.created_at.toISOString(),
      );
    }
  });

  it("carries the match's creation time when the team is attached after its matches", async () => {
    const eventId = await event();
    const team = await fx.team();
    const first = await teamMatch(
      team.id,
      new Date(Date.now() - 3 * 86400e3).toISOString(),
    );
    const second = await teamMatch(
      team.id,
      new Date(Date.now() - 2 * 86400e3).toISOString(),
    );

    await postgres.query(
      "INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)",
      [eventId, team.id],
    );

    const rows = await links(eventId);
    expect(rows.map((r) => r.match_id)).toEqual([second, first]);
    for (const row of rows) {
      expect(row.match_created_at.toISOString()).toBe(
        row.created_at.toISOString(),
      );
    }
  });
});
