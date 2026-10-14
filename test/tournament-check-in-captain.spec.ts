import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// Check-in is done by someone who plays on the team, so every entry needs a
// captain on its own roster.
describe("tournament check-in belongs to the team (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentCheckInCaptainTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199690000000n);
    tfx = new TournamentFixtures(postgres, fx);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const openTournament = async () => {
    const tournament = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    await tfx.setStatus(tournament.id, tournament.organizer, "RegistrationOpen");
    return tournament;
  };

  const mates = async (teamId: string, owner: string) =>
    (
      await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id::text FROM team_roster
          WHERE team_id = $1 AND player_steam_id <> $2
          ORDER BY player_steam_id`,
        [teamId, owner],
      )
    ).map((row) => row.player_steam_id);

  const entry = async (entryId: string) => {
    const [row] = await postgres.query<
      Array<{ captain_steam_id: string; roster: Array<string> }>
    >(
      `SELECT tt.captain_steam_id::text AS captain_steam_id,
              ARRAY(SELECT ttr.player_steam_id::text FROM tournament_team_roster ttr
                     WHERE ttr.tournament_team_id = tt.id
                     ORDER BY ttr.player_steam_id) AS roster
         FROM tournament_teams tt WHERE tt.id = $1`,
      [entryId],
    );
    return row;
  };

  it("gives an entry whose captain plays for another entry a captain from its own roster", async () => {
    const t = await openTournament();
    const teamA = await fx.team(1);
    const [shared] = await mates(teamA.id, teamA.owner);
    const teamB = await fx.team(1);
    await runAsUser(postgres, teamB.owner, "admin", async (query) => {
      await query(
        "INSERT INTO team_roster (team_id, player_steam_id, status) VALUES ($1, $2, 'Starter')",
        [teamB.id, shared],
      );
      await query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [
        teamB.id,
        shared,
      ]);
    });

    await tfx.registerTeam(t.id, teamA);
    const entryB = await tfx.registerTeam(t.id, teamB);

    const b = await entry(entryB);
    expect(b.roster).not.toContain(shared);
    expect(b.roster).toContain(b.captain_steam_id);
    expect(b.captain_steam_id).toBe(teamB.owner);
  });

  it("keeps a captain who could be seated", async () => {
    const t = await openTournament();
    const team = await fx.team(1);

    const e = await entry(await tfx.registerTeam(t.id, team));

    expect(e.captain_steam_id).toBe(team.owner);
    expect(e.roster).toContain(team.owner);
  });

  it("settles the captain once players join an entry nobody could be seated on at registration", async () => {
    const t = await openTournament();
    const teamB = await fx.team();
    const holder = await fx.player();
    const [holding] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
       VALUES ($1, 'Holding', $2) RETURNING id`,
      [t.id, holder],
    );
    await runAsUser(postgres, holder, "admin", (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [holding.id, teamB.owner, t.id],
      ),
    );
    const entryB = await tfx.registerTeam(t.id, teamB);
    expect((await entry(entryB)).roster).toEqual([]);

    const newcomer = await fx.player();
    await runAsUser(postgres, teamB.owner, "admin", (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [entryB, newcomer, t.id],
      ),
    );

    expect((await entry(entryB)).captain_steam_id).toBe(newcomer);
  });

  describe("checking in", () => {
    const controller = () =>
      new TournamentsController(
        new Logger("TournamentCheckInCaptainTest"),
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        postgres,
        { getConnection: (): null => null } as never,
      );

    const as = (steamId: string) =>
      ({ steam_id: steamId, role: "user", name: "Player" }) as never;

    const openWindow = (tournamentId: string) =>
      postgres.query(
        `UPDATE tournaments
            SET check_in_required = true,
                check_in_setting = 'Captains',
                start = now() + interval '30 minutes',
                check_in_opens_before_minutes = 60,
                check_in_closes_before_minutes = 5,
                check_in_ends_at = now() + interval '25 minutes'
          WHERE id = $1`,
        [tournamentId],
      );

    const checkedIn = async (entryId: string) => {
      const [row] = await postgres.query<Array<{ checked_in_at: string | null }>>(
        "SELECT checked_in_at FROM tournament_teams WHERE id = $1",
        [entryId],
      );
      return row.checked_in_at !== null;
    };

    it("refuses an owner who does not play on the team", async () => {
      const t = await openTournament();
      const team = await fx.team(1);
      const entryId = await tfx.registerTeam(t.id, team);
      const [mate] = await mates(team.id, team.owner);
      await postgres.query(
        "UPDATE tournament_teams SET captain_steam_id = $2 WHERE id = $1",
        [entryId, mate],
      );
      await postgres.query(
        "DELETE FROM tournament_team_roster WHERE tournament_team_id = $1 AND player_steam_id = $2",
        [entryId, team.owner],
      );
      await openWindow(t.id);

      await expect(
        controller().checkIntoTournament({
          user: as(team.owner),
          tournament_id: t.id,
          tournament_team_id: entryId,
        }),
      ).rejects.toThrow(/on its roster/);
      expect(await checkedIn(entryId)).toBe(false);
    });

    it("lets the captain who plays on the team check it in", async () => {
      const t = await openTournament();
      const team = await fx.team(1);
      const entryId = await tfx.registerTeam(t.id, team);
      await openWindow(t.id);

      await expect(
        controller().checkIntoTournament({
          user: as(team.owner),
          tournament_id: t.id,
        }),
      ).resolves.toEqual({ success: true });
      expect(await checkedIn(entryId)).toBe(true);
    });
  });
});
