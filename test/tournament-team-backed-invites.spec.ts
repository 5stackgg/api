import { PostgresService } from "../src/postgres/postgres.service";
import { InvitesController } from "../src/invites/invites.controller";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// A team-backed entry's lineup is picked from the team. Anyone from outside it
// joins by invite, and accepting puts them on the team as well, so the roster
// trigger has to turn a captain's pick into an invite instead of a force-add.
describe("team-backed tournament entries take outsiders by invite (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentTeamBackedInvites");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199400000000n);
    tfx = new TournamentFixtures(postgres, fx);
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

  // Registered the way the join form registers an existing team: no name of
  // its own, so everything shown for it has to come from the team.
  const enterTeam = async () => {
    const tournament = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    await tfx.setStatus(
      tournament.id,
      tournament.organizer,
      "RegistrationOpen",
    );
    const team = await fx.team();
    const entry = await runAsUser(
      postgres,
      team.owner,
      "admin",
      async (query) => {
        const [row] = (await query(
          "INSERT INTO tournament_teams (tournament_id, team_id) VALUES ($1, $2) RETURNING id",
          [tournament.id, team.id],
        )) as Array<{ id: string }>;
        return row.id;
      },
    );
    return { tournament, team, entry };
  };

  const addToLineup = (
    actor: string,
    role: string,
    tournamentId: string,
    entry: string,
    player: string,
  ) =>
    runAsUser(postgres, actor, role, (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [entry, player, tournamentId],
      ),
    );

  const lineup = async (entry: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        `SELECT player_steam_id::text AS steam_id FROM tournament_team_roster
          WHERE tournament_team_id = $1 ORDER BY player_steam_id`,
        [entry],
      )
    ).map((row) => row.steam_id);

  const invites = async (entry: string) =>
    (
      await postgres.query<Array<{ steam_id: string }>>(
        "SELECT steam_id::text AS steam_id FROM tournament_team_invites WHERE tournament_team_id = $1",
        [entry],
      )
    ).map((row) => row.steam_id);

  const onTeam = async (teamId: string, player: string) =>
    (
      await postgres.query<Array<{ count: number }>>(
        "SELECT count(*)::int AS count FROM team_roster WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, player],
      )
    )[0].count === 1;

  it("turns a captain's pick from outside the team into an invite", async () => {
    const { tournament, team, entry } = await enterTeam();
    const outsider = await fx.player();

    await addToLineup(team.owner, "user", tournament.id, entry, outsider);

    expect(await lineup(entry)).toEqual([team.owner]);
    expect(await invites(entry)).toEqual([outsider]);
  });

  it("still puts a team member straight onto the lineup", async () => {
    const { tournament, team, entry } = await enterTeam();
    const mate = await fx.player();
    await runAsUser(postgres, team.owner, "admin", (query) =>
      query(
        "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
        [team.id, mate],
      ),
    );

    await addToLineup(team.owner, "user", tournament.id, entry, mate);

    expect(await lineup(entry)).toEqual([team.owner, mate].sort());
    expect(await invites(entry)).toEqual([]);
  });

  it("lets the tournament's organizer place an outsider outright", async () => {
    const { tournament, entry } = await enterTeam();
    const outsider = await fx.player();

    await addToLineup(
      tournament.organizer,
      "user",
      tournament.id,
      entry,
      outsider,
    );

    expect(await lineup(entry)).toContain(outsider);
    expect(await invites(entry)).toEqual([]);
  });

  it("seats an accepted outsider on the team and the lineup together", async () => {
    const { tournament, team, entry } = await enterTeam();
    const outsider = await fx.player();

    // acceptTournamentTeamInvite's single admin request.
    await runAsUser(postgres, outsider, "admin", async (query) => {
      await query(
        "INSERT INTO team_roster (team_id, player_steam_id, role) VALUES ($1, $2, 'Member')",
        [team.id, outsider],
      );
      await query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
         VALUES ($1, $2, $3, 'Member')`,
        [entry, outsider, tournament.id],
      );
    });

    expect(await onTeam(team.id, outsider)).toBe(true);
    expect(await lineup(entry)).toContain(outsider);
  });

  it("keeps an accepted outsider off the team when the lineup has no room", async () => {
    const { tournament, team, entry } = await enterTeam();
    const [{ max }] = await postgres.query<Array<{ max: number }>>(
      "SELECT tournament_max_players_per_lineup(t) AS max FROM tournaments t WHERE id = $1",
      [tournament.id],
    );
    for (let seated = 1; seated < max; seated++) {
      await addToLineup(
        tournament.organizer,
        "admin",
        tournament.id,
        entry,
        await fx.player(),
      );
    }
    const late = await fx.player();

    await expect(
      runAsUser(postgres, late, "admin", async (query) => {
        await query(
          "INSERT INTO team_roster (team_id, player_steam_id, role) VALUES ($1, $2, 'Member')",
          [team.id, late],
        );
        await query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
           VALUES ($1, $2, $3, 'Member')`,
          [entry, late, tournament.id],
        );
      }),
    ).rejects.toThrow(/too many players/i);

    expect(await onTeam(team.id, late)).toBe(false);
  });

  it("names the team, and says it joins them to it, in the invite notification", async () => {
    const { tournament, team, entry } = await enterTeam();
    const outsider = await fx.player();
    await addToLineup(team.owner, "user", tournament.id, entry, outsider);
    const [invite] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM tournament_team_invites WHERE tournament_team_id = $1",
      [entry],
    );
    const [{ name }] = await postgres.query<Array<{ name: string }>>(
      "SELECT name FROM teams WHERE id = $1",
      [team.id],
    );
    const notifications = { notifyPlayers: jest.fn() };

    await new InvitesController(
      { warn: jest.fn() } as never,
      {} as never,
      postgres,
      notifications as never,
    ).tournament_team_invite_events({
      op: "INSERT",
      new: { id: invite.id },
    } as never);

    expect(notifications.notifyPlayers).toHaveBeenCalledTimes(1);
    const sent = notifications.notifyPlayers.mock.calls[0][1];
    expect(sent.title).toBe("Team Invite");
    expect(sent.steamIds).toEqual([outsider]);
    expect(sent.message).toContain(`join <b>${name}</b> and its lineup`);
  });
});
