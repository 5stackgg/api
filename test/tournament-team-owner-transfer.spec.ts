import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// tournament_teams.owner_steam_id is copied from the team at registration and
// carries the entry's manage rights, check-in reminders and the one team per
// owner rule. A team ownership transfer has to move it too, or the former
// owner keeps all of that for a team they no longer own.
describe("tournament entry owner follows a team ownership transfer (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentTeamOwnerTransferTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199620000000n);
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

  const openTournament = async () => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestA}'
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
    );
    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup') RETURNING id`,
      [fx.nextName("cup"), organizer, options.id],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
    );
    await setStatus(tournament.id, organizer, "RegistrationOpen");
    return { id: tournament.id, organizer };
  };

  const setStatus = (
    tournamentId: string,
    actor: string,
    status: string,
    role = "admin",
  ) =>
    runAsUser(postgres, actor, role, (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );

  const register = (tournamentId: string, teamId: string, actor: string) =>
    runAsUser(postgres, actor, "user", (query) =>
      query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name)
         SELECT $1, id, name FROM teams WHERE id = $2`,
        [tournamentId, teamId],
      ),
    );

  const transfer = (teamId: string, from: string, to: string) =>
    runAsUser(postgres, from, "user", (query) =>
      query("UPDATE teams SET owner_steam_id = $2 WHERE id = $1", [teamId, to]),
    );

  const entry = async (tournamentId: string, teamId: string) => {
    const [row] = await postgres.query<
      Array<{ owner_steam_id: string; captain_steam_id: string }>
    >(
      `SELECT owner_steam_id::text, captain_steam_id::text
       FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2`,
      [tournamentId, teamId],
    );
    return row;
  };

  const heirOf = async (teamId: string, owner: string) => {
    const [row] = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id::text FROM team_roster
       WHERE team_id = $1 AND player_steam_id <> $2
       ORDER BY player_steam_id LIMIT 1`,
      [teamId, owner],
    );
    return row.player_steam_id;
  };

  it("moves the entry to the new owner and leaves the captain alone", async () => {
    const t = await openTournament();
    const team = await fx.team(1);
    const heir = await heirOf(team.id, team.owner);
    await register(t.id, team.id, team.owner);

    await transfer(team.id, team.owner, heir);

    expect(await entry(t.id, team.id)).toEqual({
      owner_steam_id: heir,
      captain_steam_id: team.owner,
    });
  });

  it("lets the former owner register another of their teams afterwards", async () => {
    const t = await openTournament();
    const team = await fx.team(1);
    const heir = await heirOf(team.id, team.owner);
    await register(t.id, team.id, team.owner);
    const [other] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [fx.nextName("academy"), team.owner],
    );

    await transfer(team.id, team.owner, heir);

    await expect(register(t.id, other.id, team.owner)).resolves.toBeDefined();
    expect((await entry(t.id, other.id)).owner_steam_id).toBe(team.owner);
  });

  it("still moves the entry when the new owner already owns another entry", async () => {
    const t = await openTournament();
    const team = await fx.team(1);
    const heir = await heirOf(team.id, team.owner);
    const [heirsTeam] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
      [fx.nextName("own"), heir],
    );
    await register(t.id, heirsTeam.id, heir);
    await register(t.id, team.id, team.owner);

    await transfer(team.id, team.owner, heir);

    expect((await entry(t.id, team.id)).owner_steam_id).toBe(heir);
    expect((await entry(t.id, heirsTeam.id)).owner_steam_id).toBe(heir);
  });

  it.each([
    ["Finished", "administrator"],
    ["Cancelled", "admin"],
  ])("keeps the owner of record in a %s tournament", async (status, role) => {
    const t = await openTournament();
    const team = await fx.team(1);
    const heir = await heirOf(team.id, team.owner);
    await register(t.id, team.id, team.owner);
    await setStatus(t.id, t.organizer, status, role);

    await transfer(team.id, team.owner, heir);

    expect((await entry(t.id, team.id)).owner_steam_id).toBe(team.owner);
  });
});
