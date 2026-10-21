import { readFileSync } from "fs";
import * as yaml from "js-yaml";
import { join } from "path";
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

  const addMate = async (teamId: string, owner: string, role = "Member") => {
    const mate = await fx.player();
    await runAsUser(postgres, owner, "admin", async (query) => {
      await query(
        "INSERT INTO team_roster (team_id, player_steam_id) VALUES ($1, $2)",
        [teamId, mate],
      );
      await query(
        "UPDATE team_roster SET role = $3 WHERE team_id = $1 AND player_steam_id = $2",
        [teamId, mate, role],
      );
    });
    return mate;
  };

  it("refuses an outsider from a team captain who cannot invite to the team", async () => {
    const { tournament, team, entry } = await enterTeam();
    const captain = await addMate(team.id, team.owner);
    await runAsUser(postgres, team.owner, "admin", (query) =>
      query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [
        team.id,
        captain,
      ]),
    );
    const outsider = await fx.player();

    await expect(
      addToLineup(captain, "user", tournament.id, entry, outsider),
    ).rejects.toThrow(/can invite to this team/);

    expect(await invites(entry)).toEqual([]);
  });

  it("lets a team member with invite rights bring in an outsider", async () => {
    const { tournament, team, entry } = await enterTeam();
    const recruiter = await addMate(team.id, team.owner, "Invite");
    await runAsUser(postgres, team.owner, "admin", (query) =>
      query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [
        team.id,
        recruiter,
      ]),
    );
    const outsider = await fx.player();

    await addToLineup(recruiter, "user", tournament.id, entry, outsider);

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

  it("lets an internal write with no session place an outsider, as before", async () => {
    const { tournament, entry } = await enterTeam();
    const outsider = await fx.player();

    await postgres.query(
      `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
       VALUES ($1, $2, $3)`,
      [entry, outsider, tournament.id],
    );

    expect(await lineup(entry)).toContain(outsider);
    expect(await invites(entry)).toEqual([]);
  });

  it("still mirrors an outsider the league roster takes onto the season's entry", async () => {
    const { team, entry } = await enterTeam();
    const outsider = await fx.player();
    const [season] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO league_seasons (name) VALUES ($1) RETURNING id",
      [fx.nextName("season")],
    );
    const [leagueTeam] = await postgres.query<Array<{ id: string }>>(
      "INSERT INTO league_teams (team_id) VALUES ($1) RETURNING id",
      [team.id],
    );
    const [teamSeason] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO league_team_seasons (league_season_id, league_team_id, tournament_team_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [season.id, leagueTeam.id, entry],
    );

    await runAsUser(postgres, team.owner, "user", (query) =>
      query(
        `INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
         VALUES ($1, $2)`,
        [teamSeason.id, outsider],
      ),
    );

    expect(await lineup(entry)).toContain(outsider);
    expect(await invites(entry)).toEqual([]);
  });

  it("tells the web who can bring an outsider onto an entry (can_recruit)", async () => {
    const { tournament, team, entry } = await enterTeam();
    const captain = await addMate(team.id, team.owner);
    await runAsUser(postgres, team.owner, "admin", (query) =>
      query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [
        team.id,
        captain,
      ]),
    );
    const recruiter = await addMate(team.id, team.owner, "Invite");
    const stranger = await fx.player();
    const adHocOwner = await fx.player();
    const adHoc = await runAsUser(
      postgres,
      adHocOwner,
      "admin",
      async (query) => {
        const [row] = (await query(
          `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [tournament.id, fx.nextName("mix"), adHocOwner],
        )) as Array<{ id: string }>;
        return row.id;
      },
    );
    const canRecruit = async (entryId: string, steamId: string) => {
      const [row] = await postgres.query<Array<{ can: boolean }>>(
        `SELECT public.can_recruit_tournament_team_player(
                    tt,
                    json_build_object('x-hasura-role', 'user', 'x-hasura-user-id', $2::text)
                ) AS can
           FROM tournament_teams tt WHERE tt.id = $1`,
        [entryId, steamId],
      );
      return row.can;
    };

    expect(await canRecruit(entry, team.owner)).toBe(true);
    expect(await canRecruit(entry, captain)).toBe(false);
    expect(await canRecruit(entry, recruiter)).toBe(false);
    expect(await canRecruit(entry, stranger)).toBe(false);
    expect(await canRecruit(adHoc, adHocOwner)).toBe(true);
  });

  it("exposes can_recruit to every role that reads tournament teams", async () => {
    const table = yaml.load(
      readFileSync(
        join(
          process.cwd(),
          "hasura/metadata/databases/default/tables/public_tournament_teams.yaml",
        ),
        "utf8",
      ),
    ) as {
      computed_fields: Array<{ name: string; definition: unknown }>;
      select_permissions: Array<{
        role: string;
        permission: { computed_fields?: Array<string> };
      }>;
    };

    expect(
      table.computed_fields.find(({ name }) => name === "can_recruit"),
    ).toEqual({
      name: "can_recruit",
      definition: {
        function: {
          name: "can_recruit_tournament_team_player",
          schema: "public",
        },
        session_argument: "hasura_session",
      },
    });
    expect(
      table.select_permissions.map(({ role, permission }) => [
        role,
        (permission.computed_fields ?? []).includes("can_recruit"),
      ]),
    ).toEqual([["guest", true]]);

    const [fn] = await postgres.query<
      Array<{ volatility: string; result: string }>
    >(
      `SELECT p.provolatile::text AS volatility,
              pg_get_function_result(p.oid) AS result
         FROM pg_proc p
        WHERE p.oid = 'public.can_recruit_tournament_team_player(public.tournament_teams, json)'::regprocedure`,
    );
    expect(fn).toEqual({ volatility: "s", result: "boolean" });
  });

  describe("accepting", () => {
    const accept = async (
      invited: string,
      context: { tournamentId: string; entry: string; teamId: string },
    ) => {
      const [invite] = await postgres.query<Array<{ id: string }>>(
        "SELECT id FROM tournament_team_invites WHERE tournament_team_id = $1 AND steam_id = $2",
        [context.entry, invited],
      );
      const mutation = jest.fn().mockResolvedValue({});
      const hasura = {
        query: jest.fn().mockResolvedValue({
          tournament_team_invites_by_pk: {
            steam_id: invited,
            tournament_team_id: context.entry,
            team: {
              tournament_id: context.tournamentId,
              team_id: context.teamId,
            },
          },
        }),
        mutation,
      };

      await new InvitesController(
        { warn: jest.fn() } as never,
        hasura as never,
        postgres,
        {} as never,
      ).acceptInvite({
        user: { steam_id: invited, name: "invited", role: "user" } as never,
        invite_id: invite.id,
        type: "tournament-team",
      });

      return mutation.mock.calls.flatMap(([request]) => Object.keys(request));
    };

    it("joins the team when the inviter can invite to it", async () => {
      const { tournament, team, entry } = await enterTeam();
      const outsider = await fx.player();
      await addToLineup(team.owner, "user", tournament.id, entry, outsider);

      expect(
        await accept(outsider, {
          tournamentId: tournament.id,
          entry,
          teamId: team.id,
        }),
      ).toEqual([
        "insert_team_roster_one",
        "insert_tournament_team_roster_one",
        "delete_tournament_team_invites_by_pk",
      ]);
    });

    it("only seats the player when the inviter has lost the right to invite", async () => {
      const { tournament, team, entry } = await enterTeam();
      const recruiter = await addMate(team.id, team.owner, "Invite");
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query("UPDATE teams SET captain_steam_id = $2 WHERE id = $1", [
          team.id,
          recruiter,
        ]),
      );
      const outsider = await fx.player();
      await addToLineup(recruiter, "user", tournament.id, entry, outsider);
      await runAsUser(postgres, team.owner, "admin", (query) =>
        query(
          "UPDATE team_roster SET role = 'Member' WHERE team_id = $1 AND player_steam_id = $2",
          [team.id, recruiter],
        ),
      );

      expect(
        await accept(outsider, {
          tournamentId: tournament.id,
          entry,
          teamId: team.id,
        }),
      ).toEqual([
        "insert_tournament_team_roster_one",
        "delete_tournament_team_invites_by_pk",
      ]);
    });
  });
});
