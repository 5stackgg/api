import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Reproduces the "duplicate key value violates unique constraint
// tournament_roster_pkey" error seen when adding a team to a tournament.
//
// tournament_roster_pkey is PRIMARY KEY (player_steam_id, tournament_id) — a
// player may be on only ONE team per tournament. The tai_tournament_team
// auto-fill path dedupes against the whole tournament to respect this, but it
// only runs when the client does NOT supply a roster. The web join form always
// sends an explicit nested roster.data, bypassing that guard, so a supplied
// player who is already rostered elsewhere in the tournament hits the PK.
describe("tournament roster duplicate key (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentRosterDupeTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199000000000n);
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

  const createTournament = async () => {
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
    return { id: tournament.id, organizer };
  };

  const registerRealTeam = (
    tournamentId: string,
    team: { id: string; owner: string },
  ) =>
    runAsUser(postgres, team.owner, "admin", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name)
         SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id`,
        [tournamentId, team.id],
      )) as Array<{ id: string }>;
      return row.id;
    });

  it("has a composite primary key on (player_steam_id, tournament_id)", async () => {
    const cols = await postgres.query<Array<{ column_name: string }>>(
      `SELECT a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conname = 'tournament_roster_pkey'
       ORDER BY a.attname`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      "player_steam_id",
      "tournament_id",
    ]);
  });

  it("reproduces the bug: an explicit client roster with a player already in the tournament violates tournament_roster_pkey", async () => {
    const { id: tournamentId, organizer } = await createTournament();

    // Team A registers first; its owner is now rostered in the tournament.
    const teamA = await fx.team(1);
    await registerRealTeam(tournamentId, teamA);

    // The web join form adds a second (tournament-only) team and supplies an
    // explicit roster.data that includes teamA.owner (e.g. add_self / an owner
    // already playing in the tournament). This is the raw insert Hasura runs.
    await expect(
      runAsUser(postgres, organizer, "admin", async (query) => {
        const [teamB] = (await query(
          `INSERT INTO tournament_teams (tournament_id, team_id, name, owner_steam_id)
           VALUES ($1, NULL, $2, $3) RETURNING id`,
          [tournamentId, fx.nextName("bteam"), organizer],
        )) as Array<{ id: string }>;

        await query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
           VALUES ($1, $2, $3)`,
          [teamB.id, teamA.owner, tournamentId],
        );
      }),
    ).rejects.toThrow(/tournament_roster_pkey/);
  });

  it("the auto-fill path (no client roster) tolerates a shared player instead of raising", async () => {
    const { id: tournamentId } = await createTournament();

    const teamA = await fx.team(1);
    await registerRealTeam(tournamentId, teamA);

    // Team B shares teamA.owner as a member, but registers WITHOUT a client
    // roster, so tai_tournament_team auto-fills and dedupes the shared player.
    const teamB = await fx.team(1);
    await runAsUser(postgres, teamB.owner, "admin", (query) =>
      query(
        "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
        [teamB.id, teamA.owner],
      ),
    );

    const teamBTournamentId = await registerRealTeam(tournamentId, teamB);

    // The shared player stays on team A only; team B got its own members.
    const [{ count: sharedTeams }] = await postgres.query<
      Array<{ count: string }>
    >(
      `SELECT count(*)::int AS count FROM tournament_team_roster
       WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, teamA.owner],
    );
    expect(sharedTeams).toBe(1);

    const [{ count: teamBSize }] = await postgres.query<
      Array<{ count: string }>
    >(
      `SELECT count(*)::int AS count FROM tournament_team_roster
       WHERE tournament_team_id = $1`,
      [teamBTournamentId],
    );
    expect(teamBSize).toBeGreaterThan(0);
  });

  const memberIds = async (teamId: string) => {
    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      "SELECT player_steam_id FROM team_roster WHERE team_id = $1",
      [teamId],
    );
    return rows.map((r) => r.player_steam_id);
  };

  // The reported scenario: a BRAND NEW tournament, no teams/members yet, and the
  // very first team added is an existing real team with a client-supplied roster.
  // Hasura runs the nested insert as separate statements in one transaction, so
  // the tai_tournament_team auto-fill (deferred to COMMIT) fires only after the
  // client roster is present, sees it, and skips — no self-collision, and the
  // client's subset selection is honored rather than overwritten by auto-fill.
  it("first team + client roster: deferred auto-fill honors the selection without colliding", async () => {
    const { id: tournamentId } = await createTournament();
    const teamA = await fx.team(1); // owner + one mate on the team roster
    const roster = await memberIds(teamA.id);
    const selected = [roster[0]]; // client picks a subset (one player)

    const ttId = await runAsUser(
      postgres,
      teamA.owner,
      "admin",
      async (query) => {
        const [tt] = (await query(
          `INSERT INTO tournament_teams (tournament_id, team_id, name)
           SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id`,
          [tournamentId, teamA.id],
        )) as Array<{ id: string }>;

        for (const steamId of selected) {
          await query(
            `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
             VALUES ($1, $2, $3)`,
            [tt.id, steamId, tournamentId],
          );
        }
        return tt.id;
      },
    );

    const rows = await postgres.query<Array<{ player_steam_id: string }>>(
      `SELECT player_steam_id FROM tournament_team_roster WHERE tournament_team_id = $1`,
      [ttId],
    );
    expect(rows.map((r) => r.player_steam_id).sort()).toEqual(selected.sort());
  });

  it("SINGLE-statement CTE (Hasura-style nested insert): auto-fill sees the client roster and skips", async () => {
    const { id: tournamentId } = await createTournament();
    const teamA = await fx.team(1);
    const roster = await memberIds(teamA.id);

    await runAsUser(postgres, teamA.owner, "admin", (query) =>
      query(
        `WITH nt AS (
           INSERT INTO tournament_teams (tournament_id, team_id, name)
           SELECT $1, id, name FROM teams WHERE id = $2 RETURNING id
         )
         INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         SELECT nt.id, s, $1 FROM nt, unnest($3::bigint[]) AS s`,
        [tournamentId, teamA.id, roster],
      ),
    );

    const [{ count }] = await postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::int AS count FROM tournament_team_roster
       WHERE tournament_id = $1`,
      [tournamentId],
    );
    expect(count).toBe(roster.length);
  });
});
