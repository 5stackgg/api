import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Who organizes a tournament decides who passes every per-tournament check
// (awards, the MVP pick, uploads), so only the people already running it may
// change it: its owner, its co-organizers and administrators. A site-wide
// tournament organizer who does not run it may not.
describe("tournament organizers (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentOrganizersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199710000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
  ];

  const as = (steamId: string, role: string, sql: string, params: unknown[]) =>
    runAsUser(postgres, steamId, role, (query) => query(sql, params));

  const addOrganizer = (
    tournamentId: string,
    steamId: string,
    actor: string,
    role = "user",
  ) =>
    as(
      actor,
      role,
      "INSERT INTO tournament_organizers (tournament_id, steam_id) VALUES ($1, $2)",
      [tournamentId, steamId],
    );

  const removeOrganizer = (
    tournamentId: string,
    steamId: string,
    actor: string,
    role = "user",
  ) =>
    as(
      actor,
      role,
      "DELETE FROM tournament_organizers WHERE tournament_id = $1 AND steam_id = $2",
      [tournamentId, steamId],
    );

  const linkTeam = (
    tournamentId: string,
    teamId: string,
    actor: string,
    role = "user",
  ) =>
    as(
      actor,
      role,
      "INSERT INTO tournament_organizer_teams (tournament_id, team_id) VALUES ($1, $2)",
      [tournamentId, teamId],
    );

  const unlinkTeam = (
    tournamentId: string,
    teamId: string,
    actor: string,
    role = "user",
  ) =>
    as(
      actor,
      role,
      "DELETE FROM tournament_organizer_teams WHERE tournament_id = $1 AND team_id = $2",
      [tournamentId, teamId],
    );

  const organizers = async (tournamentId: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        `SELECT steam_id::text FROM tournament_organizers
          WHERE tournament_id = $1 ORDER BY steam_id`,
        [tournamentId],
      )
    ).map((row) => row.steam_id);

  const linkedTeams = async (tournamentId: string) =>
    (
      await postgres.query<Array<{ team_id: string }>>(
        "SELECT team_id FROM tournament_organizer_teams WHERE tournament_id = $1",
        [tournamentId],
      )
    ).map((row) => row.team_id);

  const failure = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the call to fail");
  };

  it("lets the owner add and remove co-organizers and organizer teams", async () => {
    const t = await tfx.createTournament(SE4);
    const [mate] = await fx.players(1);
    const team = await fx.team();

    await addOrganizer(t.id, mate, t.organizer);
    await linkTeam(t.id, team.id, t.organizer);
    expect(await organizers(t.id)).toEqual([mate]);
    expect(await linkedTeams(t.id)).toEqual([team.id]);

    await removeOrganizer(t.id, mate, t.organizer);
    await unlinkTeam(t.id, team.id, t.organizer);
    expect(await organizers(t.id)).toEqual([]);
    expect(await linkedTeams(t.id)).toEqual([]);
  });

  it("lets a co-organizer and an administrator do the same", async () => {
    const t = await tfx.createTournament(SE4);
    const [coOrganizer, mate, admin] = await fx.players(3);
    await addOrganizer(t.id, coOrganizer, t.organizer);

    await addOrganizer(t.id, mate, coOrganizer);
    expect(await organizers(t.id)).toEqual([coOrganizer, mate].sort());
    await removeOrganizer(t.id, mate, coOrganizer);

    await addOrganizer(t.id, mate, admin, "administrator");
    await removeOrganizer(t.id, coOrganizer, admin, "administrator");
    expect(await organizers(t.id)).toEqual([mate]);
  });

  it("refuses a site-wide tournament organizer who does not run the tournament", async () => {
    const t = await tfx.createTournament(SE4);
    const siteOrganizer = await fx.player(undefined, "tournament_organizer");
    const [coOrganizer] = await fx.players(1);
    const ownTeam = await fx.team();
    const linked = await fx.team();
    await addOrganizer(t.id, coOrganizer, t.organizer);
    await linkTeam(t.id, linked.id, t.organizer);

    for (const attempt of [
      addOrganizer(t.id, siteOrganizer, siteOrganizer, "tournament_organizer"),
      removeOrganizer(t.id, coOrganizer, siteOrganizer, "tournament_organizer"),
      linkTeam(t.id, ownTeam.id, siteOrganizer, "tournament_organizer"),
      unlinkTeam(t.id, linked.id, siteOrganizer, "tournament_organizer"),
    ]) {
      const error = await failure(attempt);
      expect(error.message).toMatch(/tournament's organizers/);
    }

    expect(await organizers(t.id)).toEqual([coOrganizer]);
    expect(await linkedTeams(t.id)).toEqual([linked.id]);
  });

  it("refuses a player with no part in it", async () => {
    const t = await tfx.createTournament(SE4);
    const [stranger] = await fx.players(1);

    const error = await failure(addOrganizer(t.id, stranger, stranger));
    expect(error.message).toMatch(/tournament's organizers/);
    expect(await organizers(t.id)).toEqual([]);
  });

  it("still lets the api's own writes and cascades through", async () => {
    const t = await tfx.createTournament(SE4);
    const [mate, other] = await fx.players(2);
    const team = await fx.team();

    await addOrganizer(t.id, mate, other, "admin");
    await postgres.query(
      "INSERT INTO tournament_organizers (tournament_id, steam_id) VALUES ($1, $2)",
      [t.id, other],
    );
    await linkTeam(t.id, team.id, t.organizer);
    expect(await organizers(t.id)).toEqual([mate, other].sort());

    await as(team.owner, "user", "DELETE FROM teams WHERE id = $1", [team.id]);
    expect(await linkedTeams(t.id)).toEqual([]);

    await as(t.organizer, "user", "DELETE FROM tournaments WHERE id = $1", [
      t.id,
    ]);
    expect(await organizers(t.id)).toEqual([]);
  });
});
