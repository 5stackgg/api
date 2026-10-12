import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { HasuraPermissions } from "./utils/hasura-permissions";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  runAsUser,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Whoever may add a player to a team's tournament roster may also take one
// off: the entry owner, the team owner, the team captain and a team Admin. A
// team-backed entry's roster is auto-filled as 'Member', so none of them hold
// the tournament roster's own Admin role. The delete runs with the filter
// compiled from the Hasura metadata, as the engine would add it, while the
// roster lock still guards the seeded bracket underneath.
describe("tournament roster removals by team managers (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let permissions: HasuraPermissions;

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentRosterManagersTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199890000000n);
    tfx = new TournamentFixtures(postgres, fx);
    permissions = new HasuraPermissions(postgres);
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

  // A Wingman entry (two per lineup, three substitutes) for a five-player
  // team: owner, captain, team Admin, a plain member and the player removed.
  const entry = async () => {
    const t = await tfx.createTournament([
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ]);
    await postgres.query(
      `UPDATE match_options SET number_of_substitutes = 3
        WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
      [t.id],
    );
    await tfx.setStatus(t.id, t.organizer, "RegistrationOpen");

    const team = await fx.team(4);
    const mates = (
      await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id::text AS player_steam_id FROM team_roster
          WHERE team_id = $1 AND player_steam_id <> $2
          ORDER BY player_steam_id`,
        [team.id, team.owner],
      )
    ).map((row) => row.player_steam_id);
    const [captain, teamAdmin, member, player] = mates;

    await postgres.query(
      "UPDATE teams SET captain_steam_id = $2 WHERE id = $1",
      [team.id, captain],
    );
    await postgres.query(
      "UPDATE team_roster SET role = 'Admin' WHERE team_id = $1 AND player_steam_id = $2",
      [team.id, teamAdmin],
    );

    const tournamentTeamId = await tfx.registerTeam(t.id, team);

    const roles = await postgres.query<Array<{ role: string }>>(
      "SELECT DISTINCT role FROM tournament_team_roster WHERE tournament_team_id = $1",
      [tournamentTeamId],
    );
    expect(roles).toEqual([{ role: "Member" }]);

    return {
      tournament: t,
      tournamentTeamId,
      owner: team.owner,
      captain,
      teamAdmin,
      member,
      player,
    };
  };

  const removeAs = async (
    actor: string,
    role: string,
    tournamentTeamId: string,
    player: string,
  ): Promise<number> => {
    const params: Array<unknown> = [tournamentTeamId, player];
    const filter = await permissions.where(
      "tournament_team_roster",
      "delete",
      "ttr",
      { role, userId: actor },
      params,
    );

    const removed = (await runAsUser(postgres, actor, role, (query) =>
      query(
        `DELETE FROM tournament_team_roster ttr
          WHERE ttr.tournament_team_id = $1
            AND ttr.player_steam_id = $2
            AND ${filter}
         RETURNING ttr.player_steam_id`,
        params,
      ),
    )) as Array<{ player_steam_id: string }>;

    return removed.length;
  };

  it("lets the team owner remove a player", async () => {
    const e = await entry();

    expect(await removeAs(e.owner, "user", e.tournamentTeamId, e.player)).toBe(
      1,
    );
  });

  it("lets the team captain remove a player", async () => {
    const e = await entry();

    expect(
      await removeAs(e.captain, "user", e.tournamentTeamId, e.player),
    ).toBe(1);
  });

  it("lets a team Admin remove a player", async () => {
    const e = await entry();

    expect(
      await removeAs(e.teamAdmin, "user", e.tournamentTeamId, e.player),
    ).toBe(1);
  });

  it("still lets a player remove themselves", async () => {
    const e = await entry();

    expect(await removeAs(e.player, "user", e.tournamentTeamId, e.player)).toBe(
      1,
    );
  });

  it("refuses a plain member and an outsider", async () => {
    const e = await entry();
    const outsider = await fx.player();

    expect(await removeAs(e.member, "user", e.tournamentTeamId, e.player)).toBe(
      0,
    );
    expect(await removeAs(outsider, "user", e.tournamentTeamId, e.player)).toBe(
      0,
    );
  });

  describe("once the bracket is seeded", () => {
    const seeded = async () => {
      const e = await entry();
      for (let i = 0; i < 3; i++) {
        await tfx.registerTeam(e.tournament.id, await fx.team(1));
      }
      await tfx.setStatus(
        e.tournament.id,
        e.tournament.organizer,
        "RegistrationClosed",
      );
      return e;
    };

    it("lets the owner swap players out but never below the minimum lineup", async () => {
      const e = await seeded();

      for (const player of [e.player, e.member, e.teamAdmin]) {
        expect(
          await removeAs(e.owner, "user", e.tournamentTeamId, player),
        ).toBe(1);
      }

      await expect(
        removeAs(e.owner, "user", e.tournamentTeamId, e.captain),
      ).rejects.toThrow(/minimum lineup/);
    });

    it("refuses the owner once the tournament is live", async () => {
      const e = await seeded();
      await tfx.setStatus(e.tournament.id, e.tournament.organizer, "Live");
      expect(await tfx.tournamentStatus(e.tournament.id)).toBe("Live");

      expect(
        await removeAs(e.owner, "user", e.tournamentTeamId, e.player),
      ).toBe(0);
    });
  });
});
