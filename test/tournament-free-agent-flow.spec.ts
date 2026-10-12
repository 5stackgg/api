import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { ProcessTournamentCheckIn } from "./../src/matches/jobs/ProcessTournamentCheckIn";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// The free agent journey through the actions a player actually calls: sign up,
// leave, get drafted or waitlisted, get promoted, check in. A player is in a
// tournament once -- on a team or in the pool, never both.
describe("free agent flow (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const notifications = { notifyPlayers: jest.fn() };

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentFreeAgentFlowTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561198300000000n);
    await fx.region("TestFF");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    notifications.notifyPlayers.mockReset();
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  // Wingman, so a drafted team is two players.
  const createTournament = async ({
    registrationType = "free_agents",
    start = "3 days",
    maxTeams = 4,
    columns = {} as Record<string, string | number | boolean>,
  } = {}) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestFF}', 0
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
    );

    const names = Object.keys(columns);
    const extraCols = names.map((name) => `, "${name}"`).join("");
    const extraVals = names.map((_, i) => `, $${i + 6}`).join("");

    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status, registration_type${extraCols})
       VALUES ($1, now() + $2::interval, $3, $4, 'Setup', $5${extraVals}) RETURNING id`,
      [
        fx.nextName("flow"),
        start,
        organizer,
        options.id,
        registrationType,
        ...names.map((name) => columns[name]),
      ],
    );

    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, $2)`,
      [tournament.id, maxTeams],
    );

    return { id: tournament.id, organizer };
  };

  const setStatus = (tournamentId: string, actor: string, status: string) =>
    runAsUser(postgres, actor, "admin", (query) =>
      query("UPDATE tournaments SET status = $1 WHERE id = $2", [
        status,
        tournamentId,
      ]),
    );

  const openTournament = async (
    options: Parameters<typeof createTournament>[0] = {},
  ) => {
    const t = await createTournament(options);
    await setStatus(t.id, t.organizer, "RegistrationOpen");
    return t;
  };

  const controller = () =>
    new TournamentsController(
      new Logger("TournamentFreeAgentFlowTest"),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      notifications as never,
      postgres,
      { getConnection: () => ({}) } as never,
    );

  const user = (steamId: string) =>
    ({ steam_id: steamId, name: "Player", role: "user" }) as never;

  const join = (tournamentId: string, steamId: string) =>
    controller().joinTournamentAsFreeAgent({
      user: user(steamId),
      tournament_id: tournamentId,
    });

  const leave = (tournamentId: string, steamId: string) =>
    controller().leaveTournamentAsFreeAgent({
      user: user(steamId),
      tournament_id: tournamentId,
    });

  const draft = (t: { id: string; organizer: string }) =>
    controller().draftTournamentTeams({
      user: user(t.organizer),
      tournament_id: t.id,
    });

  const checkIn = (tournamentId: string, steamId: string) =>
    controller().checkIntoTournament({
      user: user(steamId),
      tournament_id: tournamentId,
    });

  // Sequential awaits, so every sign-up lands at a later now() than the one
  // before it -- created_at is the queue.
  const joinAll = async (tournamentId: string, steamIds: Array<string>) => {
    for (const steamId of steamIds) {
      await join(tournamentId, steamId);
    }
  };

  type Agent = {
    status: string;
    tournament_team_id: string | null;
    created_at: Date;
  };

  const agentRow = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<Agent>>(
      `SELECT status, tournament_team_id, created_at
         FROM tournament_free_agents
        WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, steamId],
    );
    return row;
  };

  const statusOf = async (tournamentId: string, steamId: string) =>
    (await agentRow(tournamentId, steamId))?.status ?? null;

  const teamOf = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<{ tournament_team_id: string }>>(
      `SELECT tournament_team_id FROM tournament_team_roster
        WHERE tournament_id = $1 AND player_steam_id = $2`,
      [tournamentId, steamId],
    );
    return row?.tournament_team_id ?? null;
  };

  type PickupTeam = {
    id: string;
    owner_steam_id: string;
    captain_steam_id: string;
  };

  const pickupTeams = (tournamentId: string) =>
    postgres.query<Array<PickupTeam>>(
      `SELECT id, owner_steam_id::text AS owner_steam_id,
              captain_steam_id::text AS captain_steam_id
         FROM tournament_teams
        WHERE tournament_id = $1 AND is_drafted
        ORDER BY name`,
      [tournamentId],
    );

  const rosterOf = (teamId: string) =>
    postgres.query<Array<{ steam_id: string; role: string }>>(
      `SELECT player_steam_id::text AS steam_id, role
         FROM tournament_team_roster
        WHERE tournament_team_id = $1
        ORDER BY player_steam_id`,
      [teamId],
    );

  // The draft makes one player per pickup team its stand-in owner, and owning a
  // team is its own refusal; this is a drafted player who only plays.
  const nonOwner = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ steam_id: string }>>(
      `SELECT ttr.player_steam_id::text AS steam_id
         FROM tournament_team_roster ttr
         JOIN tournament_teams tt ON tt.id = ttr.tournament_team_id
        WHERE ttr.tournament_id = $1
          AND tt.owner_steam_id <> ttr.player_steam_id
        ORDER BY ttr.player_steam_id
        LIMIT 1`,
      [tournamentId],
    );
    return row.steam_id;
  };

  const joined = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<{ joined: boolean }>>(
      `SELECT joined_tournament(t, json_build_object('x-hasura-user-id', $2::text)) AS joined
         FROM tournaments t WHERE t.id = $1`,
      [tournamentId, steamId],
    );
    return row.joined;
  };

  // An ad-hoc team, its roster written under an admin session the way the
  // organizer tools and the invite-accept action write it.
  const registerTeam = async (
    tournamentId: string,
    owner: string,
    members: Array<string> = [],
  ) => {
    const [team] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
       VALUES ($1, $2, $3, $3) RETURNING id`,
      [tournamentId, `squad-${owner}`, owner],
    );

    for (const member of members) {
      await addToRoster(tournamentId, team.id, member);
    }

    return team.id;
  };

  const addToRoster = (tournamentId: string, teamId: string, steamId: string) =>
    runAsUser(postgres, steamId, "admin", (query) =>
      query(
        `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
         VALUES ($1, $2, $3)`,
        [teamId, steamId, tournamentId],
      ),
    );

  describe("a team or the pool, never both", () => {
    it("refuses the pool to a player already on a team's roster", async () => {
      const t = await openTournament({ registrationType: "both" });
      const [owner, member] = await fx.players(2);
      await registerTeam(t.id, owner, [owner, member]);

      await expect(join(t.id, member)).rejects.toThrow(/already on a team/i);

      // The Hasura insert permission is not a way around the action.
      await expect(
        runAsUser(postgres, member, "user", (query) =>
          query(
            `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
             VALUES ($1, $2)`,
            [t.id, member],
          ),
        ),
      ).rejects.toThrow(/already on a team/i);

      expect(await agentRow(t.id, member)).toBeUndefined();
    });

    it("refuses the pool to a drafted player, who is already on a pickup team", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const drafted = await nonOwner(t.id);
      expect(await statusOf(t.id, drafted)).toBe("drafted");
      await expect(join(t.id, drafted)).rejects.toThrow(/already on a team/i);
      expect(await statusOf(t.id, drafted)).toBe("drafted");
    });

    it("takes a free agent out of the pool when they accept a team invite", async () => {
      const t = await openTournament({ registrationType: "both" });
      const [owner, agent] = await fx.players(2);
      await join(t.id, agent);
      const team = await registerTeam(t.id, owner, [owner]);

      // What acceptTournamentTeamInvite writes, through the admin client.
      await addToRoster(t.id, team, agent);

      expect(await teamOf(t.id, agent)).toBe(team);
      expect(await agentRow(t.id, agent)).toBeUndefined();
    });

    it("takes a free agent out of the pool when their 5stack team registers with them on it", async () => {
      const t = await openTournament({ registrationType: "both" });
      const squad = await fx.team(1);
      const [{ mate }] = await postgres.query<Array<{ mate: string }>>(
        `SELECT player_steam_id::text AS mate FROM team_roster
          WHERE team_id = $1 AND player_steam_id <> $2`,
        [squad.id, squad.owner],
      );
      await join(t.id, mate);

      // The roster is auto-filled from the team at commit (tai_tournament_team).
      const tournamentTeam = await runAsUser(
        postgres,
        squad.owner,
        "user",
        async (query) => {
          const [row] = (await query(
            `INSERT INTO tournament_teams (tournament_id, team_id, name)
             VALUES ($1, $2, 'Squad') RETURNING id`,
            [t.id, squad.id],
          )) as Array<{ id: string }>;
          return row.id;
        },
      );

      expect(await teamOf(t.id, mate)).toBe(tournamentTeam);
      expect(await agentRow(t.id, mate)).toBeUndefined();
    });

    it("lets a free agent leave the pool by registering a team of their own", async () => {
      const t = await openTournament({ registrationType: "both" });
      const agent = await fx.player();
      await join(t.id, agent);

      const canJoin = async () => {
        const [row] = await postgres.query<Array<{ can_join: boolean }>>(
          `SELECT can_join_tournament(t, json_build_object(
                      'x-hasura-role', 'user',
                      'x-hasura-user-id', $2::text)) AS can_join
             FROM tournaments t WHERE t.id = $1`,
          [t.id, agent],
        );
        return row.can_join;
      };

      expect(await canJoin()).toBe(true);

      await runAsUser(postgres, agent, "user", (query) =>
        query(
          `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
           VALUES ($1, 'Mine', $2)`,
          [t.id, agent],
        ),
      );

      expect(await agentRow(t.id, agent)).toBeUndefined();
      expect(await canJoin()).toBe(false);
    });

    it("takes a waitlisted free agent off the waitlist when they join a team", async () => {
      const t = await openTournament({ registrationType: "both" });
      const players = await fx.players(3);
      await joinAll(t.id, players);
      await draft(t);

      const [first, second, waitlisted] = players;
      expect(await statusOf(t.id, waitlisted)).toBe("waitlisted");

      const owner = await fx.player();
      const team = await registerTeam(t.id, owner, [owner]);
      await addToRoster(t.id, team, waitlisted);

      expect(await agentRow(t.id, waitlisted)).toBeUndefined();

      // A slot opening on the pickup team leaves them where they chose to be.
      const pickup = await teamOf(t.id, first);
      await leave(t.id, first);
      expect(await teamOf(t.id, waitlisted)).toBe(team);
      expect(await teamOf(t.id, second)).toBe(pickup);
    });
  });

  describe("recruiting from the pool", () => {
    // What the web's add-player and pool Invite buttons both send.
    const addAsCaptain = (
      tournamentId: string,
      teamId: string,
      captain: string,
      steamId: string,
    ) =>
      runAsUser(postgres, captain, "user", (query) =>
        query(
          `INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id)
           VALUES ($1, $2, $3)`,
          [teamId, steamId, tournamentId],
        ),
      );

    const invitedTo = async (teamId: string) =>
      (
        await postgres.query<Array<{ steam_id: string }>>(
          `SELECT steam_id::text AS steam_id FROM tournament_team_invites
            WHERE tournament_team_id = $1`,
          [teamId],
        )
      ).map((invite) => invite.steam_id);

    it("asks a free agent before a 5stack team puts them on its roster", async () => {
      const t = await openTournament({ registrationType: "both" });
      const squad = await fx.team();
      const agent = await fx.player();
      await join(t.id, agent);

      const tournamentTeam = await runAsUser(
        postgres,
        squad.owner,
        "user",
        async (query) => {
          const [row] = (await query(
            `INSERT INTO tournament_teams (tournament_id, team_id, name)
             VALUES ($1, $2, 'Squad') RETURNING id`,
            [t.id, squad.id],
          )) as Array<{ id: string }>;
          return row.id;
        },
      );

      await addAsCaptain(t.id, tournamentTeam, squad.owner, agent);

      expect(await teamOf(t.id, agent)).toBeNull();
      expect(await statusOf(t.id, agent)).toBe("registered");
      expect(await invitedTo(tournamentTeam)).toEqual([agent]);

      // What acceptTournamentTeamInvite writes, through the admin client.
      await addToRoster(t.id, tournamentTeam, agent);

      expect(await teamOf(t.id, agent)).toBe(tournamentTeam);
      expect(await agentRow(t.id, agent)).toBeUndefined();
    });

    it("will not let a player invite themselves onto someone else's team", async () => {
      const t = await openTournament({ registrationType: "both" });
      const squad = await fx.team();
      const [captain, agent] = await fx.players(2);
      await join(t.id, agent);
      const adHoc = await registerTeam(t.id, captain, [captain]);
      const teamBacked = await runAsUser(
        postgres,
        squad.owner,
        "user",
        async (query) => {
          const [row] = (await query(
            `INSERT INTO tournament_teams (tournament_id, team_id, name)
             VALUES ($1, $2, 'Squad') RETURNING id`,
            [t.id, squad.id],
          )) as Array<{ id: string }>;
          return row.id;
        },
      );

      for (const team of [adHoc, teamBacked]) {
        await expect(addAsCaptain(t.id, team, agent, agent)).rejects.toThrow(
          /cannot add players to this team/i,
        );
        expect(await invitedTo(team)).toEqual([]);
      }
      expect(await statusOf(t.id, agent)).toBe("registered");
    });

    it("lets the tournament's organizer place a free agent outright", async () => {
      const t = await openTournament({ registrationType: "both" });
      const squad = await fx.team();
      const agent = await fx.player();
      await join(t.id, agent);
      const teamBacked = await runAsUser(
        postgres,
        squad.owner,
        "user",
        async (query) => {
          const [row] = (await query(
            `INSERT INTO tournament_teams (tournament_id, team_id, name)
             VALUES ($1, $2, 'Squad') RETURNING id`,
            [t.id, squad.id],
          )) as Array<{ id: string }>;
          return row.id;
        },
      );

      await addAsCaptain(t.id, teamBacked, t.organizer, agent);

      expect(await teamOf(t.id, agent)).toBe(teamBacked);
      expect(await agentRow(t.id, agent)).toBeUndefined();
    });

    it("will not put a team from one tournament on another's roster", async () => {
      const t = await openTournament({ registrationType: "both" });
      const other = await openTournament({ registrationType: "both" });
      const [captain, agent] = await fx.players(2);
      await join(t.id, agent);
      const team = await registerTeam(other.id, captain, [captain]);

      await expect(addAsCaptain(t.id, team, captain, agent)).rejects.toThrow(
        /not in this tournament/i,
      );
      expect(await invitedTo(team)).toEqual([]);
    });

    it("stops recruiting when registration closes", async () => {
      const t = await openTournament({ registrationType: "both" });
      const [captain, agent] = await fx.players(2);
      await join(t.id, agent);
      const team = await registerTeam(t.id, captain, [captain]);
      await setStatus(t.id, t.organizer, "RegistrationClosed");

      await expect(addAsCaptain(t.id, team, captain, agent)).rejects.toThrow(
        /cannot add players to this team/i,
      );
      expect(await invitedTo(team)).toEqual([]);
    });

    it("will not invite a player who is already on a team", async () => {
      const t = await openTournament({ registrationType: "both" });
      const [captain, rival, taken] = await fx.players(3);
      const team = await registerTeam(t.id, captain, [captain]);
      await registerTeam(t.id, rival, [rival, taken]);

      await expect(addAsCaptain(t.id, team, captain, taken)).rejects.toThrow(
        /already on a team/i,
      );
      expect(await invitedTo(team)).toEqual([]);
    });
  });

  describe("signing up and leaving", () => {
    it("only takes sign-ups while registration is open", async () => {
      const t = await createTournament();
      const players = await fx.players(4);

      await expect(join(t.id, players[0])).rejects.toThrow(
        /registration is not open/i,
      );

      await setStatus(t.id, t.organizer, "RegistrationOpen");
      await joinAll(t.id, players);

      // Signing up twice is the same sign-up.
      await expect(join(t.id, players[0])).resolves.toEqual({
        success: true,
      });
      const [count] = await postgres.query<Array<{ count: number }>>(
        "SELECT count(*)::int AS count FROM tournament_free_agents WHERE tournament_id = $1",
        [t.id],
      );
      expect(count.count).toBe(4);

      await setStatus(t.id, t.organizer, "RegistrationClosed");

      await expect(join(t.id, await fx.player())).rejects.toThrow(
        /registration is not open/i,
      );
    });

    it("drafts on close in sign-up order, and a player who left and came back queues at the back", async () => {
      const t = await openTournament();
      const players = await fx.players(5);
      await joinAll(t.id, players);

      await leave(t.id, players[0]);
      expect(await agentRow(t.id, players[0])).toBeUndefined();
      await join(t.id, players[0]);

      await setStatus(t.id, t.organizer, "RegistrationClosed");

      expect(await statusOf(t.id, players[0])).toBe("waitlisted");
      expect(await teamOf(t.id, players[0])).toBeNull();

      // Every drafted row points at the team whose roster holds them.
      for (const steamId of players.slice(1)) {
        const row = await agentRow(t.id, steamId);
        expect(row.status).toBe("drafted");
        expect(row.tournament_team_id).not.toBeNull();
        expect(await teamOf(t.id, steamId)).toBe(row.tournament_team_id);
      }

      const teams = await postgres.query<
        Array<{ seed: number | null; eligible_at: Date | null }>
      >(
        "SELECT seed, eligible_at FROM tournament_teams WHERE tournament_id = $1 AND is_drafted",
        [t.id],
      );
      expect(teams).toHaveLength(2);
      expect(teams.every((team) => team.seed !== null)).toBe(true);
      expect(teams.every((team) => team.eligible_at !== null)).toBe(true);
    });

    it("lets a waitlisted player step off the waitlist after registration closes, but holds a drafted player to their slot", async () => {
      const t = await openTournament();
      const players = await fx.players(5);
      await joinAll(t.id, players);
      await setStatus(t.id, t.organizer, "RegistrationClosed");

      const waitlisted = players[4];
      expect(await statusOf(t.id, waitlisted)).toBe("waitlisted");

      await expect(leave(t.id, waitlisted)).resolves.toEqual({
        success: true,
      });
      expect(await agentRow(t.id, waitlisted)).toBeUndefined();

      await expect(leave(t.id, players[0])).rejects.toThrow();
      expect(await statusOf(t.id, players[0])).toBe("drafted");
    });

    it("signs a withdrawn player back up as a fresh entry rather than reporting a sign-up that did nothing", async () => {
      const t = await openTournament();
      const players = await fx.players(5);
      await joinAll(t.id, players);
      await draft(t);

      // The organizer removes a drafted player -- the team's stand-in owner, so
      // the team is handed on too -- and the waitlist fills the slot.
      const [{ id: team, owner_steam_id: removed }] = await pickupTeams(t.id);
      await postgres.query(
        `DELETE FROM tournament_team_roster
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, removed],
      );
      expect(await statusOf(t.id, removed)).toBe("withdrawn");
      expect(await teamOf(t.id, players[4])).toBe(team);
      const [handedOn] = await pickupTeams(t.id);
      expect(handedOn.id).toBe(team);
      expect(handedOn.owner_steam_id).not.toBe(removed);

      await expect(join(t.id, removed)).resolves.toEqual({ success: true });

      const row = await agentRow(t.id, removed);
      expect(row.status).toBe("waitlisted");
      expect(row.tournament_team_id).toBeNull();

      const [latest] = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id::text AS player_steam_id FROM tournament_free_agents
          WHERE tournament_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [t.id],
      );
      expect(latest.player_steam_id).toBe(removed);
    });
  });

  describe("the draft", () => {
    // Standing Wingman ratings, hung off one finished match so
    // get_tournament_player_elo has something to read.
    const seedElo = async (ratings: Record<string, number>) => {
      const { matchId } = await fx.bareMatch();
      for (const [steamId, current] of Object.entries(ratings)) {
        await postgres.query(
          `INSERT INTO player_elo (steam_id, match_id, "type", current, change, created_at)
           VALUES ($1, $2, 'Wingman', $3, 0, now() - interval '30 days')`,
          [steamId, matchId, current],
        );
      }
    };

    it("balances the teams by rating", async () => {
      const t = await openTournament();
      const players = await fx.players(8);
      await seedElo(
        Object.fromEntries(
          players.map((steamId, index) => [steamId, 8000 - index * 1000]),
        ),
      );
      await joinAll(t.id, players);

      expect((await draft(t)).teams_created).toBe(4);

      const totals = await postgres.query<Array<{ total: string }>>(
        `SELECT SUM(get_tournament_player_elo($1, ttr.player_steam_id))::text AS total
           FROM tournament_team_roster ttr
          WHERE ttr.tournament_id = $1
          GROUP BY ttr.tournament_team_id`,
        [t.id],
      );

      expect(totals.map((row) => Number(row.total))).toEqual([
        9000, 9000, 9000, 9000,
      ]);
    });

    it("drafts only once", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));

      expect((await draft(t)).teams_created).toBe(2);
      expect((await draft(t)).teams_created).toBe(0);
    });
  });

  describe("signing up after the teams were drafted", () => {
    it("waitlists a late sign-up instead of leaving it waiting on a draft that already ran", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));
      expect((await draft(t)).teams_created).toBe(2);

      const late = await fx.player();
      await join(t.id, late);
      expect(await statusOf(t.id, late)).toBe("waitlisted");

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await statusOf(t.id, late)).toBe("waitlisted");
    });

    // Two drafted teams, one of them a player short after a drafted player left
    // with nobody waiting to replace them.
    const shortPickupTeam = async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const [team] = await pickupTeams(t.id);
      const [leaver] = (await rosterOf(team.id)).filter(
        (member) => member.steam_id !== team.owner_steam_id,
      );
      await leave(t.id, leaver.steam_id);
      expect(await rosterOf(team.id)).toHaveLength(1);

      return { t, team: team.id };
    };

    it("drafts a waiting player the organizer places on a pickup team by hand", async () => {
      const t = await openTournament();
      // A substitute seat: room on the roster that promotion, which only fills
      // a team to its lineup, never offers.
      await postgres.query(
        `UPDATE match_options SET number_of_substitutes = 1
          WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [t.id],
      );
      const players = await fx.players(5);
      await joinAll(t.id, players);
      await draft(t);

      const placed = players[4];
      expect(await statusOf(t.id, placed)).toBe("waitlisted");
      const [team] = await pickupTeams(t.id);

      await addToRoster(t.id, team.id, placed);

      const row = await agentRow(t.id, placed);
      expect(row.status).toBe("drafted");
      expect(row.tournament_team_id).toBe(team.id);
    });

    // A full field drafted while registration is open already has round-1
    // matches; the seat a drafted player leaves goes to the waitlist, and the
    // matches are rebuilt when registration closes.
    it("promotes the waitlist into a slot a drafted player leaves once the bracket is filled", async () => {
      const t = await openTournament({ maxTeams: 4 });
      const players = await fx.players(9);
      await joinAll(t.id, players);
      await draft(t);
      expect(await pickupTeams(t.id)).toHaveLength(4);
      const waitlisted = players[8];
      expect(await statusOf(t.id, waitlisted)).toBe("waitlisted");

      const leaver = await nonOwner(t.id);
      const team = await teamOf(t.id, leaver);
      await expect(leave(t.id, leaver)).resolves.toEqual({ success: true });

      expect(await statusOf(t.id, waitlisted)).toBe("drafted");
      expect(await teamOf(t.id, waitlisted)).toBe(team);
    });

    // No substitutes, so the pickup team sits at its minimum: the waitlist is
    // the only way to fill the seat, and leaving the review redraws the bracket.
    it("lets an organizer swap a drafted no-show for the waitlist while check-in is under review", async () => {
      const t = await openTournament({ columns: { check_in_required: true } });
      const players = await fx.players(5);
      await joinAll(t.id, players);
      await draft(t);
      const waitlisted = players[4];
      expect(await statusOf(t.id, waitlisted)).toBe("waitlisted");
      await setStatus(t.id, t.organizer, "CheckInReview");

      const noShow = await nonOwner(t.id);
      const team = await teamOf(t.id, noShow);
      await runAsUser(postgres, t.organizer, "tournament_organizer", (query) =>
        query(
          `DELETE FROM tournament_team_roster
            WHERE tournament_id = $1 AND player_steam_id = $2`,
          [t.id, noShow],
        ),
      );

      expect(await statusOf(t.id, noShow)).toBe("withdrawn");
      expect(await statusOf(t.id, waitlisted)).toBe("drafted");
      expect(await teamOf(t.id, waitlisted)).toBe(team);
    });

    it("puts a late sign-up straight into a slot a drafted player gave up", async () => {
      const t = await openTournament();
      const players = await fx.players(4);
      await joinAll(t.id, players);
      await draft(t);

      const team = await teamOf(t.id, players[0]);
      await leave(t.id, players[0]);

      const late = await fx.player();
      await join(t.id, late);

      expect(await statusOf(t.id, late)).toBe("drafted");
      expect(await teamOf(t.id, late)).toBe(team);
    });
  });

  describe("a pickup team's stand-in owner leaving", () => {
    it("hands the team to a teammate, and lets the owner back into the pool", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const [team] = await pickupTeams(t.id);
      const owner = team.owner_steam_id;
      expect(team.captain_steam_id).toBe(owner);
      const [teammate] = (await rosterOf(team.id))
        .map((row) => row.steam_id)
        .filter((steamId) => steamId !== owner);

      await leave(t.id, owner);

      const [handedOn] = await pickupTeams(t.id);
      expect(handedOn.id).toBe(team.id);
      expect(handedOn.owner_steam_id).toBe(teammate);
      expect(handedOn.captain_steam_id).toBe(teammate);
      expect(await rosterOf(team.id)).toEqual([
        { steam_id: teammate, role: "Admin" },
      ]);

      // Nothing ties them to the tournament any more, so they can sign up
      // again -- straight back into the slot they left, as the only one waiting.
      expect(await joined(t.id, owner)).toBe(false);
      await expect(join(t.id, owner)).resolves.toEqual({ success: true });
      expect(await teamOf(t.id, owner)).toBe(team.id);
    });

    it("dissolves a pickup team nobody is left on", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const [emptied, kept] = await pickupTeams(t.id);
      for (const { steam_id } of await rosterOf(emptied.id)) {
        await leave(t.id, steam_id);
      }

      expect((await pickupTeams(t.id)).map((team) => team.id)).toEqual([
        kept.id,
      ]);
      expect(await joined(t.id, emptied.owner_steam_id)).toBe(false);
    });
  });

  describe("check-in", () => {
    const job = () =>
      new ProcessTournamentCheckIn(
        new Logger("TournamentFreeAgentFlowJobTest"),
        postgres,
        notifications as never,
      );

    it("drafts the free agents who confirmed and waitlists the one who did not", async () => {
      const t = await openTournament({
        columns: { check_in_required: true },
      });
      const players = await fx.players(5);
      await joinAll(t.id, players);

      // Signed up before the window, so nobody is auto-stamped.
      await postgres.query(
        "UPDATE tournaments SET start = now() + interval '30 minutes' WHERE id = $1",
        [t.id],
      );
      await job().process();

      const [noShow, ...present] = players;
      for (const steamId of present) {
        await checkIn(t.id, steamId);
      }

      // Signing up inside the window counts as present.
      const late = await fx.player();
      await join(t.id, late);
      expect((await agentRow(t.id, late)).status).toBe("registered");

      await postgres.query(
        "UPDATE tournaments SET check_in_ends_at = now() - interval '1 minute' WHERE id = $1",
        [t.id],
      );
      await job().process();

      const [tournament] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [t.id],
      );
      expect(tournament.status).toBe("RegistrationClosed");

      expect(await statusOf(t.id, noShow)).toBe("waitlisted");
      expect(await teamOf(t.id, noShow)).toBeNull();

      const drafted = await postgres.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM tournament_free_agents
          WHERE tournament_id = $1 AND status = 'drafted'`,
        [t.id],
      );
      expect(drafted[0].count).toBe(4);

      // A no-show cannot confirm after the deadline.
      await expect(checkIn(t.id, noShow)).rejects.toThrow(/not open/i);
    });
  });
});
