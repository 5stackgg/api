import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Reproduces "insert or update on table event_match_links violates foreign key
// constraint event_match_links_match_id_fkey", raised when taking a tournament
// that is attached to an event Live.
//
// schedule_tournament_match() sets tournament_brackets.match_id BEFORE
// inserting the matches row (that FK is DEFERRABLE INITIALLY DEFERRED so
// tai_match can already see the bracket link). tg_brackets_sync_event_match_links
// fires in that gap, and v_event_matches' tournament branch read tb.match_id
// without joining matches, so the sync tried to link a match that did not exist
// yet against an immediate FK — killing the whole status transition.
describe("event <-> tournament match links (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("EventTournamentLinksTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199300000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM events");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const createEvent = async (startsAt: string, endsAt: string | null) => {
    const organizer = await fx.player();
    const [event] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO events (name, starts_at, ends_at, organizer_steam_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [fx.nextName("event"), startsAt, endsAt, organizer],
    );
    return event.id;
  };

  const attach = (eventId: string, tournamentId: string) =>
    postgres.query(
      "INSERT INTO event_tournaments (event_id, tournament_id) VALUES ($1, $2)",
      [eventId, tournamentId],
    );

  const linkedMatchIds = async (eventId: string) => {
    const rows = await postgres.query<Array<{ match_id: string }>>(
      "SELECT match_id FROM event_match_links WHERE event_id = $1 ORDER BY match_id",
      [eventId],
    );
    return rows.map((r) => r.match_id);
  };

  const bracketMatchIds = async (stageId: string) => {
    const brackets = await tfx.getBrackets(stageId);
    return brackets
      .map((b) => b.match_id)
      .filter((id): id is string => id !== null)
      .sort();
  };

  it("reproduces the bug: taking an attached tournament Live schedules matches without an FK violation", async () => {
    const eventId = await createEvent(new Date().toISOString(), null);

    const tournament = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    await attach(eventId, tournament.id);

    await tfx.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );

    // This is the mutation that failed in production with
    // event_match_links_match_id_fkey; it must simply go through.
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    expect(await tfx.tournamentStatus(tournament.id)).toBe("Live");

    // The scheduled matches are linked to the event once the matches rows land.
    const scheduled = await bracketMatchIds(tournament.stageIds[0]);
    expect(scheduled.length).toBeGreaterThan(0);
    expect(await linkedMatchIds(eventId)).toEqual(scheduled);
  });

  it("the tournament branch never emits a match that does not exist", async () => {
    const eventId = await createEvent(new Date().toISOString(), null);
    const tournament = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    await attach(eventId, tournament.id);

    const [{ count: phantoms }] = await postgres.query<
      Array<{ count: number }>
    >(
      `SELECT count(*)::int AS count
       FROM v_event_matches v
       LEFT JOIN matches m ON m.id = v.match_id
       WHERE m.id IS NULL`,
    );
    expect(phantoms).toBe(0);

    // Attaching after the fact still backfills the links.
    expect(await linkedMatchIds(eventId)).toEqual(
      await bracketMatchIds(tournament.stageIds[0]),
    );
  });

  // The tournament branch is deliberately unwindowed: an attached tournament's
  // matches are the event's whatever the dates say. Guards the new join to
  // matches against accidentally dragging that branch under `windowed`.
  it("links an attached tournament's matches even outside the event window", async () => {
    const eventId = await createEvent(
      "2020-01-01T00:00:00Z",
      "2020-01-02T00:00:00Z",
    );
    const tournament = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    await attach(eventId, tournament.id);

    const scheduled = await bracketMatchIds(tournament.stageIds[0]);
    expect(scheduled.length).toBeGreaterThan(0);
    expect(await linkedMatchIds(eventId)).toEqual(scheduled);
  });
});
