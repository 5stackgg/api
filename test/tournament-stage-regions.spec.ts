import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// A stage can override the tournament's region settings, including picking a
// LAN region. Covers the clone path stage options take on their way into the
// scheduled matches, and the role gate that keeps players off LAN regions.
describe("tournament stage region overrides (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  const SE4: Array<{
    type: string;
    order: number;
    minTeams: number;
    maxTeams: number;
  }> = [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 4 }];

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentStageRegionsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199400000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA", 27015);
    // Two Ranked regions keeps tbi_match_options out of its single-region
    // branch, which rewrites regions to every enabled server region.
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

  const stageOptions = async (
    stageId: string,
    regions: Array<string>,
  ): Promise<string> => {
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       SELECT 8, 1, 'Wingman', id, false, false, $1
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
      [regions],
    );
    await postgres.query(
      `UPDATE tournament_stages SET match_options_id = $1 WHERE id = $2`,
      [options.id, stageId],
    );
    return options.id;
  };

  const launchWithStageRegions = async (regions: Array<string>) => {
    const tournament = await tfx.createTournament(SE4);
    await stageOptions(tournament.stageIds[0], regions);

    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationOpen",
    );
    for (let i = 0; i < 4; i++) {
      await tfx.registerTeam(tournament.id, await fx.team(1));
    }
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationClosed",
    );
    await tfx.setStatus(tournament.id, tournament.organizer, "Live");

    return tournament;
  };

  const matchRegions = (stageId: string) =>
    postgres.query<Array<{ regions: Array<string>; region_veto: boolean }>>(
      `SELECT mo.regions, mo.region_veto
       FROM tournament_brackets tb
       INNER JOIN matches m ON m.id = tb.match_id
       INNER JOIN match_options mo ON mo.id = m.match_options_id
       WHERE tb.tournament_stage_id = $1`,
      [stageId],
    );

  it("carries a stage's LAN region into every match it schedules", async () => {
    const tournament = await launchWithStageRegions(["TestLan"]);

    const matches = await matchRegions(tournament.stageIds[0]);

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.regions).toEqual(["TestLan"]);
      expect(match.region_veto).toBe(false);
    }
  });

  it("leaves the tournament's own region alone when the stage overrides nothing", async () => {
    const tournament = await tfx.launch(SE4, 4);

    const matches = await matchRegions(tournament.stageIds[0]);

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.regions).toEqual(["TestA"]);
    }
  });

  it("refuses a LAN region on stage options written by a player", async () => {
    const tournament = await tfx.createTournament(SE4);

    await expect(
      runAsUser(postgres, tournament.organizer, "user", (query) =>
        query(
          `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
           SELECT 8, 1, 'Wingman', id, false, false, '{TestLan}'
           FROM map_pools WHERE type = 'Wingman' AND seed = true`,
        ),
      ),
    ).rejects.toThrow(/Cannot assign the Lan region/);
  });
});
