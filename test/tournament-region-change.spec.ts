import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// An organizer moves a tournament onto the LAN region and the first matches
// still came out on the region it was created with: round 1 is drawn (and its
// options cloned) at RegistrationClosed, and a stage that customized any
// advanced setting carries its own full snapshot of the tournament's options.
describe("changing a tournament's region before it starts (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  const SE4 = [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }];

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentRegionChangeTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199500000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA", 27015);
    await seedRegionWithServer(postgres, "TestB", 27017);
    await postgres.query(
      `INSERT INTO server_regions (value, description, is_lan)
       VALUES ('TestLan', 'TestLan', true) ON CONFLICT (value) DO NOTHING`,
    );
    await postgres.query(
      `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled)
       VALUES ('127.0.0.1', 'TestLan', $1, 27016, 'TestLan', 'Ranked', true, true)`,
      [Buffer.from("password")],
    );
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

  const moveTournamentTo = (tournamentId: string, region: string) =>
    postgres.query(
      `UPDATE match_options SET regions = $2, region_veto = false
       WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
      [tournamentId, [region]],
    );

  // What TournamentStageForm.createMatchOptions writes: a full copy of the
  // tournament's options carrying whichever advanced settings differ.
  const giveStageOwnOptions = async (
    tournamentId: string,
    stageId: string,
    overrides: { regions?: Array<string>; tv_delay?: number },
  ) => {
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, tv_delay)
       SELECT mr, best_of, type, map_pool_id, map_veto,
              CASE WHEN $2::text[] IS NULL THEN region_veto ELSE false END,
              COALESCE($2::text[], regions),
              COALESCE($3::int, tv_delay)
       FROM match_options
       WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)
       RETURNING id`,
      [tournamentId, overrides.regions ?? null, overrides.tv_delay ?? null],
    );
    await postgres.query(
      `UPDATE tournament_stages SET match_options_id = $1 WHERE id = $2`,
      [options.id, stageId],
    );
  };

  const closeRegistration = async (tournament: {
    id: string;
    organizer: string;
  }) => {
    await tfx.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
  };

  const roundMatches = (stageId: string, round: number) =>
    postgres.query<
      Array<{
        id: string;
        match_options_id: string;
        regions: Array<string>;
        region: string | null;
        status: string;
        tv_delay: number;
      }>
    >(
      `SELECT m.id, m.match_options_id, mo.regions, m.region, m.status, mo.tv_delay
       FROM tournament_brackets tb
       INNER JOIN matches m ON m.id = tb.match_id
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       WHERE tb.tournament_stage_id = $1 AND tb.round = $2
       ORDER BY tb.match_number`,
      [stageId, round],
    );

  it("hosts round 1 on a region chosen before the draw", async () => {
    const tournament = await tfx.createTournament(SE4);
    await moveTournamentTo(tournament.id, "TestLan");

    await closeRegistration(tournament);
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    const matches = await roundMatches(tournament.stageIds[0], 1);

    expect(matches.length).toBe(2);
    for (const match of matches) {
      expect(match.regions).toEqual(["TestLan"]);
      expect(match.region).toBe("TestLan");
    }
  });

  it("moves already-drawn round 1 matches when the region changes afterwards", async () => {
    const tournament = await tfx.createTournament(SE4);
    await closeRegistration(tournament);

    const drawn = await roundMatches(tournament.stageIds[0], 1);
    expect(drawn.map((match) => match.status)).toEqual([
      "Scheduled",
      "Scheduled",
    ]);

    await moveTournamentTo(tournament.id, "TestLan");
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    const matches = await roundMatches(tournament.stageIds[0], 1);

    expect(matches.length).toBe(2);
    for (const match of matches) {
      expect(match.regions).toEqual(["TestLan"]);
      expect(match.region).toBe("TestLan");
    }
  });

  it("moves matches still waiting for check-in once the tournament is live", async () => {
    const tournament = await tfx.createTournament(SE4);
    await closeRegistration(tournament);
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    await moveTournamentTo(tournament.id, "TestLan");

    const matches = await roundMatches(tournament.stageIds[0], 1);

    expect(matches.map((match) => match.status)).toEqual([
      "WaitingForCheckIn",
      "WaitingForCheckIn",
    ]);
    for (const match of matches) {
      expect(match.regions).toEqual(["TestLan"]);
      expect(match.region).toBe("TestLan");
    }
  });

  it("carries the new region through a stage that only customized tv_delay", async () => {
    const tournament = await tfx.createTournament(SE4);
    await giveStageOwnOptions(tournament.id, tournament.stageIds[0], {
      tv_delay: 90,
    });

    await moveTournamentTo(tournament.id, "TestLan");
    await closeRegistration(tournament);
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    const matches = await roundMatches(tournament.stageIds[0], 1);

    expect(matches.length).toBe(2);
    for (const match of matches) {
      expect(match.regions).toEqual(["TestLan"]);
      expect(match.region).toBe("TestLan");
      expect(match.tv_delay).toBe(90);
    }
  });

  it("carries the new region through such a stage after the draw too", async () => {
    const tournament = await tfx.createTournament(SE4);
    await giveStageOwnOptions(tournament.id, tournament.stageIds[0], {
      tv_delay: 90,
    });
    await closeRegistration(tournament);

    await moveTournamentTo(tournament.id, "TestLan");

    const matches = await roundMatches(tournament.stageIds[0], 1);

    expect(matches.length).toBe(2);
    for (const match of matches) {
      expect(match.regions).toEqual(["TestLan"]);
      expect(match.region).toBe("TestLan");
      expect(match.tv_delay).toBe(90);
    }
  });

  it("leaves a stage on the region it deliberately overrode", async () => {
    const tournament = await tfx.createTournament(SE4);
    await giveStageOwnOptions(tournament.id, tournament.stageIds[0], {
      regions: ["TestLan"],
    });
    await closeRegistration(tournament);

    await moveTournamentTo(tournament.id, "TestB");

    const matches = await roundMatches(tournament.stageIds[0], 1);

    expect(matches.length).toBe(2);
    for (const match of matches) {
      expect(match.regions).toEqual(["TestLan"]);
      expect(match.region).toBe("TestLan");
    }
  });

  it("leaves a hand-edited match where the organizer put it", async () => {
    const tournament = await tfx.createTournament(SE4);
    await closeRegistration(tournament);

    const [edited] = await roundMatches(tournament.stageIds[0], 1);
    await postgres.query(
      `UPDATE match_options SET regions = '{TestLan}', region_veto = false WHERE id = $1`,
      [edited.match_options_id],
    );

    await moveTournamentTo(tournament.id, "TestB");

    const matches = await roundMatches(tournament.stageIds[0], 1);

    expect(matches.map((match) => match.region)).toEqual(["TestLan", "TestB"]);
  });

  it("does not reach back into finished matches", async () => {
    const tournament = await tfx.createTournament(SE4);
    await closeRegistration(tournament);
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");
    await tfx.playRound(tournament.stageIds[0], 1);

    await moveTournamentTo(tournament.id, "TestLan");

    const played = await roundMatches(tournament.stageIds[0], 1);
    const final = await roundMatches(tournament.stageIds[0], 2);

    for (const match of played) {
      expect(match.regions).toEqual(["TestA"]);
    }
    expect(final.length).toBe(1);
    expect(final[0].regions).toEqual(["TestLan"]);
    expect(final[0].region).toBe("TestLan");
  });
});
