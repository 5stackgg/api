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

  // Pins the view's invariant directly rather than waiting for the FK to blow
  // up: event_match_links_match_id_fkey is deferrable, so a phantom row would
  // survive to COMMIT and this suite would go green on a broken view.
  it("the tournament branch never emits a match that does not exist", async () => {
    const eventId = await createEvent(new Date().toISOString(), null);
    const tournament = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    await attach(eventId, tournament.id);

    // Recreate the window schedule_tournament_match() opens: the bracket points
    // at a matches row that does not exist yet (its FK is deferred), so the
    // view must simply not yield that bracket.
    let phantomsInWindow = -1;
    await expect(
      postgres.transaction(async (client) => {
        await client.query(
          `UPDATE tournament_brackets SET match_id = gen_random_uuid()
           WHERE id = (SELECT id FROM tournament_brackets
                       WHERE tournament_stage_id = $1 ORDER BY match_number LIMIT 1)`,
          [tournament.stageIds[0]],
        );
        const { rows } = await client.query(
          `SELECT count(*)::int AS count
           FROM v_event_matches v
           LEFT JOIN matches m ON m.id = v.match_id
           WHERE m.id IS NULL`,
        );
        phantomsInWindow = rows[0].count;
        throw new Error("__rollback__");
      }),
    ).rejects.toThrow("__rollback__");
    expect(phantomsInWindow).toBe(0);

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

  it("event and tournament boards list a player once one of their matches has finished", async () => {
    const eventId = await createEvent(new Date().toISOString(), null);
    const tournament = await tfx.launch(
      [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
      4,
    );
    await attach(eventId, tournament.id);

    const [finished, live] = await bracketMatchIds(tournament.stageIds[0]);
    const playAKill = async (matchId: string) => {
      const [map] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_maps (match_id, map_id, "order")
         SELECT $1, id, 1 FROM maps ORDER BY name LIMIT 1 RETURNING id`,
        [matchId],
      );
      const lineups = await postgres.query<Array<{ steam_id: string }>>(
        `SELECT mlp.steam_id FROM match_lineup_players mlp
           JOIN matches m ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
          WHERE m.id = $1
          ORDER BY mlp.match_lineup_id = m.lineup_1_id DESC`,
        [matchId],
      );
      const attacker = String(lineups[0].steam_id);
      const victim = String(lineups[lineups.length - 1].steam_id);
      await fx.kill({ matchId, mapId: map.id }, attacker, victim);
      await fx.round(map.id, 1);
      return attacker;
    };
    const finishedPlayer = await playAKill(finished);
    const livePlayer = await playAKill(live);
    await tfx.winMatch(finished);

    const eventBoard = await postgres.query<
      Array<{ player_steam_id: string; matches_played: number }>
    >("SELECT * FROM get_event_leaderboard($1, 'kills')", [eventId]);
    const tournamentBoard = await postgres.query<
      Array<{ player_steam_id: string; matches_played: number }>
    >("SELECT * FROM get_tournament_leaderboard($1)", [tournament.id]);

    for (const board of [eventBoard, tournamentBoard]) {
      const ids = board.map((row) => String(row.player_steam_id));
      expect(ids).toContain(finishedPlayer);
      expect(ids).not.toContain(livePlayer);
      const row = board.find(
        (entry) => String(entry.player_steam_id) === finishedPlayer,
      );
      expect(Number(row?.matches_played)).toBe(1);
    }
  });
});
