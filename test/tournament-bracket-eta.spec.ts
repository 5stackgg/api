import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises calculate_tournament_bracket_start_times: each bracket's projected
// scheduled_eta from its feeders, then the queue of unfinished brackets onto
// the tournament's servers. A Bo1 slot is 75 minutes (60 + 15 of slack).
describe("tournament bracket ETAs (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 },
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentBracketEtaTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199820000000n);
    tfx = new TournamentFixtures(postgres, fx);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    // Matches before tournaments: bracket cascade triggers touch sibling
    // brackets mid-delete otherwise.
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
    // Capacity is the region's server count, so every test starts with one.
    await postgres.query("DELETE FROM servers");
    await seedRegionWithServer(postgres, "TestA");
  });

  // Recalculates and reads the ETAs back in one transaction, so they are
  // reported in minutes from the now() the projection itself used.
  const projected = (tournament: { id: string; organizer: string }) =>
    runAsUser(postgres, tournament.organizer, "admin", async (query) => {
      await query("SELECT calculate_tournament_bracket_start_times($1)", [
        tournament.id,
      ]);
      const rows = (await query(
        `SELECT tb.round, tb.match_number,
                round(extract(epoch FROM tb.scheduled_eta - now()) / 60)::int AS minutes
         FROM tournament_brackets tb
         JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
         WHERE ts.tournament_id = $1
         ORDER BY tb.round, tb.match_number`,
        [tournament.id],
      )) as Array<{ round: number; match_number: number; minutes: number }>;
      return rows.map((row) => [row.round, row.match_number, row.minutes]);
    });

  const openingMatch = async (tournamentId: string, matchNumber: number) => {
    const [row] = await postgres.query<Array<{ match_id: string }>>(
      `SELECT tb.match_id FROM tournament_brackets tb
       JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       WHERE ts.tournament_id = $1 AND tb.round = 1 AND tb.match_number = $2`,
      [tournamentId, matchNumber],
    );
    return row.match_id;
  };

  it("queues a fresh bracket onto its one server, each round after its feeders", async () => {
    const tournament = await tfx.launch(SE4, 4);

    expect(await projected(tournament)).toEqual([
      [1, 1, 0],
      [1, 2, 75],
      [2, 1, 150],
    ]);
  });

  it("runs the opening round side by side with a second server", async () => {
    await seedRegionWithServer(postgres, "TestA", 27016);
    const tournament = await tfx.launch(SE4, 4);

    expect(await projected(tournament)).toEqual([
      [1, 1, 0],
      [1, 2, 0],
      [2, 1, 75],
    ]);
  });

  it("stops queueing a finished bracket and frees its slot", async () => {
    const tournament = await tfx.launch(SE4, 4);
    await tfx.winMatch(await openingMatch(tournament.id, 1));

    expect(await projected(tournament)).toEqual([
      [1, 1, 0],
      [1, 2, 0],
      [2, 1, 75],
    ]);
  });

  it("keeps a live match on its server from when it started", async () => {
    const tournament = await tfx.launch(SE4, 4);
    const match = await openingMatch(tournament.id, 1);
    // Going Live needs maps this tournament never picked; skip the match
    // triggers, only the status and start time matter here.
    await runAsUser(postgres, tournament.organizer, "admin", async (query) => {
      await query("SET LOCAL session_replication_role = replica");
      await query(
        `UPDATE matches SET status = 'Live', started_at = now() - interval '30 minutes'
         WHERE id = $1`,
        [match],
      );
    });

    // The live match holds the only server until 45 minutes from now, but
    // the final still waits on the other opener's full 75-minute slot.
    expect(await projected(tournament)).toEqual([
      [1, 1, -30],
      [1, 2, 75],
      [2, 1, 150],
    ]);
  });

  it("sizes each slot by the stage's best-of", async () => {
    const tournament = await tfx.launch(SE4, 4);
    await postgres.query(
      "UPDATE tournament_stages SET default_best_of = 3 WHERE tournament_id = $1",
      [tournament.id],
    );

    expect(await projected(tournament)).toEqual([
      [1, 1, 0],
      [1, 2, 195],
      [2, 1, 390],
    ]);
  });

  it("projects nothing until the tournament is Live", async () => {
    const tournament = await tfx.createTournament(SE4);
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationOpen",
    );
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }

    const rows = await postgres.query<Array<{ scheduled_eta: Date | null }>>(
      `SELECT tb.scheduled_eta FROM tournament_brackets tb
       JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
       WHERE ts.tournament_id = $1`,
      [tournament.id],
    );
    expect(rows.every((row) => row.scheduled_eta === null)).toBe(true);
  });

  it("leaves brackets whose ETA did not move untouched", async () => {
    const tournament = await tfx.launch(SE4, 4);

    const rewritten = await runAsUser(
      postgres,
      tournament.organizer,
      "admin",
      async (query) => {
        const versions = () =>
          query(
            `SELECT tb.id, tb.ctid::text AS version FROM tournament_brackets tb
             JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
             WHERE ts.tournament_id = $1 ORDER BY tb.id`,
            [tournament.id],
          );
        await query("SELECT calculate_tournament_bracket_start_times($1)", [
          tournament.id,
        ]);
        const before = await versions();
        // Same transaction, same now(): nothing to change.
        await query("SELECT calculate_tournament_bracket_start_times($1)", [
          tournament.id,
        ]);
        return { before, after: await versions() };
      },
    );

    expect(rewritten.after).toEqual(rewritten.before);
  });
});
