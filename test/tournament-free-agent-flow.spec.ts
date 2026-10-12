import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PostgresService } from "./../src/postgres/postgres.service";
import { TournamentsController } from "./../src/tournaments/tournaments.controller";
import { ProcessTournamentCheckIn } from "./../src/matches/jobs/ProcessTournamentCheckIn";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  endPool,
  runAsUser,
  SqlTestDb,
} from "./utils/sql-test-db";

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

    // The pool is the field: a team entered beside it takes a bracket slot the
    // draft was counting on. The organizer can still seat one by hand.
    it("refuses a team registration in a free-agents-only tournament, except from its organizer", async () => {
      const t = await openTournament();
      const owner = await fx.player();

      await expect(
        runAsUser(postgres, owner, "user", (query) =>
          query(
            `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
             VALUES ($1, $2, $3)`,
            [t.id, `squad-${owner}`, owner],
          ),
        ),
      ).rejects.toThrow(/only accepts free agents/i);

      await runAsUser(postgres, t.organizer, "user", (query) =>
        query(
          `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id)
           VALUES ($1, 'Seated', $2)`,
          [t.id, t.organizer],
        ),
      );

      const teams = await postgres.query<Array<{ name: string }>>(
        "SELECT name FROM tournament_teams WHERE tournament_id = $1",
        [t.id],
      );
      expect(teams).toEqual([{ name: "Seated" }]);
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

    // Team names are unique per tournament, so a collision aborts the close and
    // leaves the tournament stuck in RegistrationOpen.
    it("names its teams around a registered team that already took a pickup name", async () => {
      const t = await openTournament({ registrationType: "both" });
      const owner = await fx.player();
      await postgres.query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, 'Team 2', $2, $2)`,
        [t.id, owner],
      );
      await joinAll(t.id, await fx.players(4));

      await setStatus(t.id, t.organizer, "RegistrationClosed");

      const names = await postgres.query<Array<{ name: string }>>(
        `SELECT name FROM tournament_teams
          WHERE tournament_id = $1 AND is_drafted
          ORDER BY name`,
        [t.id],
      );
      expect(names.map((row) => row.name)).toEqual(["Team 3", "Team 4"]);
    });

    // The same rule promotion applies: a ban or a rating past the cap after the
    // sign-up takes them out of the selection, not just out of the queue.
    it("passes over a player who no longer meets the entry requirements", async () => {
      const t = await openTournament();
      const players = await fx.players(5);
      await joinAll(t.id, players);

      const [lapsed, ...eligible] = players;
      await postgres.query(
        "UPDATE players SET role = 'verified_user' WHERE steam_id = ANY($1::bigint[])",
        [eligible],
      );
      await postgres.query(
        "UPDATE tournaments SET min_role = 'verified_user' WHERE id = $1",
        [t.id],
      );

      expect((await draft(t)).teams_created).toBe(2);

      expect(await teamOf(t.id, lapsed)).toBeNull();
      expect(await statusOf(t.id, lapsed)).toBe("waitlisted");
      for (const steamId of eligible) {
        expect(await statusOf(t.id, steamId)).toBe("drafted");
      }
    });

    // tau_tournaments only seeds on the way out of registration, so a team
    // drafted when a closed tournament starts has no slot in the bracket.
    it("never drafts a team once the bracket has been drawn", async () => {
      const t = await openTournament({ registrationType: "both" });
      const registered: Array<string> = [];
      for (let i = 0; i < 4; i++) {
        const [owner, member] = await fx.players(2);
        registered.push(await registerTeam(t.id, owner, [owner, member]));
      }
      const agents = await fx.players(2);
      await joinAll(t.id, agents);

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await pickupTeams(t.id)).toEqual([]);

      await postgres.query("DELETE FROM tournament_teams WHERE id = $1", [
        registered[0],
      ]);

      await setStatus(t.id, t.organizer, "Live");

      expect(await pickupTeams(t.id)).toEqual([]);
      for (const steamId of agents) {
        expect(await statusOf(t.id, steamId)).toBe("registered");
      }
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

    // A registered team chose its players; a stranger off the waitlist is not
    // a replacement it asked for. Its captain recruits by invite instead.
    it("never fills a registered team's vacancy from the waitlist", async () => {
      const t = await openTournament({ registrationType: "both" });
      const [owner, member] = await fx.players(2);
      const premade = await registerTeam(t.id, owner, [owner, member]);

      const players = await fx.players(5);
      await joinAll(t.id, players);
      expect((await draft(t)).teams_created).toBe(2);
      const waiting = players[4];
      expect(await statusOf(t.id, waiting)).toBe("waitlisted");

      await postgres.query(
        `DELETE FROM tournament_team_roster
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, member],
      );

      expect((await rosterOf(premade)).map((row) => row.steam_id)).toEqual([
        owner,
      ]);
      expect(await statusOf(t.id, waiting)).toBe("waitlisted");
      expect(await teamOf(t.id, waiting)).toBeNull();
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

  describe("the field before the draft", () => {
    const tournamentStatus = async (tournamentId: string) => {
      const [row] = await postgres.query<Array<{ status: string }>>(
        "SELECT status FROM tournaments WHERE id = $1",
        [tournamentId],
      );
      return row.status;
    };

    const hasMinTeams = async (tournamentId: string) => {
      const [row] = await postgres.query<Array<{ ok: boolean }>>(
        "SELECT tournament_has_min_teams(t) AS ok FROM tournaments t WHERE t.id = $1",
        [tournamentId],
      );
      return row.ok;
    };

    const canStart = async (t: { id: string; organizer: string }) => {
      const [row] = await postgres.query<Array<{ ok: boolean }>>(
        `SELECT can_start_tournament(
                  t,
                  json_build_object('x-hasura-role', 'user', 'x-hasura-user-id', $2::text)
                ) AS ok
           FROM tournaments t WHERE t.id = $1`,
        [t.id, t.organizer],
      );
      return row.ok;
    };

    // The update CancelInvalidTournaments sends once the start time passes;
    // its has_min_teams filter is tournament_has_min_teams.
    const cancelIfShort = async (tournamentId: string) => {
      await postgres.query(
        "UPDATE tournaments SET start = now() - interval '1 minute' WHERE id = $1",
        [tournamentId],
      );
      await postgres.query(
        `UPDATE tournaments t
            SET status = 'CancelledMinTeams'
          WHERE t.id = $1
            AND t.status IN ('RegistrationOpen', 'CheckInReview')
            AND NOT tournament_has_min_teams(t)
            AND t.start <= now()`,
        [tournamentId],
      );
    };

    // Nothing closes registration on its own without check-in, so a pool that
    // fills the bracket sits in RegistrationOpen past its start -- with zero
    // teams until the draft.
    it("counts the teams a full pool will make, and does not cancel it", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(8));

      expect(await hasMinTeams(t.id)).toBe(true);
      expect(await canStart(t)).toBe(true);

      await cancelIfShort(t.id);
      expect(await tournamentStatus(t.id)).toBe("RegistrationOpen");
    });

    it("still cancels a pool that cannot make the field, counting only the room the bracket has left", async () => {
      const short = await openTournament();
      await joinAll(short.id, await fx.players(7));
      expect(await hasMinTeams(short.id)).toBe(false);
      await cancelIfShort(short.id);
      expect(await tournamentStatus(short.id)).toBe("CancelledMinTeams");

      // Two full teams and a third still recruiting leave room for one pickup
      // team, however many the pool could make.
      const both = await openTournament({ registrationType: "both" });
      for (let i = 0; i < 2; i++) {
        const [owner, member] = await fx.players(2);
        await registerTeam(both.id, owner, [owner, member]);
      }
      const recruiting = await fx.player();
      await registerTeam(both.id, recruiting, [recruiting]);
      await joinAll(both.id, await fx.players(4));

      expect(await hasMinTeams(both.id)).toBe(false);
      expect(await canStart(both)).toBe(false);
      expect((await draft(both)).teams_created).toBe(1);
    });

    // The draft runs once, so whatever a cancelled run drafted has to be undone
    // or the next close drafts nobody.
    it("drafts the whole pool again after a cancelled start is reset", async () => {
      const t = await openTournament();
      const early = await fx.players(5);
      await joinAll(t.id, early);

      await setStatus(t.id, t.organizer, "Live");
      expect(await tournamentStatus(t.id)).toBe("CancelledMinTeams");
      expect(await pickupTeams(t.id)).toHaveLength(2);

      await setStatus(t.id, t.organizer, "Setup");
      expect(await pickupTeams(t.id)).toEqual([]);
      for (const steamId of early) {
        const row = await agentRow(t.id, steamId);
        expect(row.status).toBe("registered");
        expect(row.tournament_team_id).toBeNull();
      }

      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const late = await fx.players(3);
      await joinAll(t.id, late);
      for (const steamId of late) {
        expect(await statusOf(t.id, steamId)).toBe("registered");
      }

      await setStatus(t.id, t.organizer, "Live");
      expect(await tournamentStatus(t.id)).toBe("Live");
      expect(await pickupTeams(t.id)).toHaveLength(4);
    });

    it("drafts the late sign-ups too when registration is reopened after closing", async () => {
      const t = await openTournament();
      const early = await fx.players(5);
      await joinAll(t.id, early);

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await pickupTeams(t.id)).toHaveLength(2);

      await setStatus(t.id, t.organizer, "RegistrationOpen");
      expect(await pickupTeams(t.id)).toEqual([]);

      const late = await fx.players(3);
      await joinAll(t.id, late);

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await pickupTeams(t.id)).toHaveLength(4);
      for (const steamId of [...early, ...late]) {
        expect(await statusOf(t.id, steamId)).toBe("drafted");
      }
    });

    // The close pass waitlisted them, not the draft -- the same no-show a team
    // that missed the window stays unseeded for.
    it("leaves a check-in no-show on the waitlist when the draft is undone", async () => {
      const job = () =>
        new ProcessTournamentCheckIn(
          new Logger("TournamentFreeAgentUndoJobTest"),
          postgres,
          notifications as never,
        );

      const t = await openTournament({
        columns: { check_in_required: true },
      });
      const players = await fx.players(5);
      await joinAll(t.id, players);

      await postgres.query(
        "UPDATE tournaments SET start = now() + interval '30 minutes' WHERE id = $1",
        [t.id],
      );
      await job().process();

      const [noShow, ...present] = players;
      for (const steamId of present) {
        await checkIn(t.id, steamId);
      }

      await postgres.query(
        "UPDATE tournaments SET check_in_ends_at = now() - interval '1 minute' WHERE id = $1",
        [t.id],
      );
      await job().process();
      expect(await tournamentStatus(t.id)).toBe("RegistrationClosed");
      expect(await pickupTeams(t.id)).toHaveLength(2);

      await setStatus(t.id, t.organizer, "RegistrationOpen");

      expect(await statusOf(t.id, noShow)).toBe("waitlisted");
      for (const steamId of present) {
        expect(await statusOf(t.id, steamId)).toBe("registered");
      }
    });

    const drawnTeams = async (tournamentId: string) => {
      const [bracket] = await postgres.query<
        Array<{ team_ids: Array<string> | null }>
      >(
        `SELECT array_agg(DISTINCT team_id) AS team_ids
           FROM tournament_brackets tb
           JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
          CROSS JOIN LATERAL (VALUES (tb.tournament_team_id_1), (tb.tournament_team_id_2)) AS slot(team_id)
          WHERE ts.tournament_id = $1 AND slot.team_id IS NOT NULL`,
        [tournamentId],
      );
      return [...(bracket.team_ids ?? [])].sort();
    };

    const seedsOf = async (teamIds: Array<string>) => {
      const rows = await postgres.query<
        Array<{ id: string; seed: number | null }>
      >("SELECT id, seed FROM tournament_teams WHERE id = ANY($1::uuid[])", [
        teamIds,
      ]);
      return teamIds.map(
        (teamId) => rows.find((row) => row.id === teamId)!.seed,
      );
    };

    // A seed kept past the size of the next field has no bracket slot, so the
    // gaps the pickup teams leave are closed up when they go.
    it("closes up the registered teams' seeds when the pickup teams are undone, and draws the whole field", async () => {
      const t = await openTournament({
        registrationType: "both",
        maxTeams: 16,
      });
      const registered: Array<string> = [];
      for (let i = 0; i < 4; i++) {
        const [owner, member] = await fx.players(2);
        registered.push(await registerTeam(t.id, owner, [owner, member]));
      }
      const agents = await fx.players(8);
      await joinAll(t.id, agents);

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      const pickups = (await pickupTeams(t.id)).map((team) => team.id);
      expect(pickups).toHaveLength(4);

      await postgres.query(
        "UPDATE tournament_teams SET seed = NULL WHERE tournament_id = $1",
        [t.id],
      );
      const draw: Array<[string, number]> = [
        [registered[0], 3],
        [registered[1], 5],
        [registered[2], 7],
        [registered[3], 8],
        [pickups[0], 1],
        [pickups[1], 2],
        [pickups[2], 4],
        [pickups[3], 6],
      ];
      for (const [teamId, seed] of draw) {
        await postgres.query(
          "UPDATE tournament_teams SET seed = $2 WHERE id = $1",
          [teamId, seed],
        );
      }

      await setStatus(t.id, t.organizer, "RegistrationOpen");
      expect(await seedsOf(registered)).toEqual([1, 2, 3, 4]);

      await leave(t.id, agents[0]);
      await leave(t.id, agents[1]);
      await setStatus(t.id, t.organizer, "RegistrationClosed");

      expect(await pickupTeams(t.id)).toHaveLength(3);
      expect(await seedsOf(registered)).toEqual([1, 2, 3, 4]);

      const teams = await postgres.query<Array<{ id: string; seed: number }>>(
        "SELECT id, seed FROM tournament_teams WHERE tournament_id = $1 ORDER BY seed",
        [t.id],
      );
      expect(teams.map((team) => team.seed)).toEqual([1, 2, 3, 4, 5, 6, 7]);

      expect(await drawnTeams(t.id)).toEqual(
        teams.map((team) => team.id).sort(),
      );
    });

    it("closes up the seeds of a team that withdrew after the undo, so every remaining team is drawn", async () => {
      const t = await openTournament({
        registrationType: "both",
        maxTeams: 16,
      });
      const registered: Array<string> = [];
      for (let i = 0; i < 5; i++) {
        const [owner, member] = await fx.players(2);
        registered.push(await registerTeam(t.id, owner, [owner, member]));
      }
      const agents = await fx.players(2);
      await joinAll(t.id, agents);

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await pickupTeams(t.id)).toHaveLength(1);

      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const reopened = await seedsOf(registered);
      expect([...reopened].sort()).toEqual([1, 2, 3, 4, 5]);

      const withdrawn = registered[reopened.indexOf(2)];
      await postgres.query("DELETE FROM tournament_teams WHERE id = $1", [
        withdrawn,
      ]);
      await leave(t.id, agents[0]);
      await setStatus(t.id, t.organizer, "RegistrationClosed");

      expect(await pickupTeams(t.id)).toEqual([]);
      const remaining = registered
        .filter((teamId) => teamId !== withdrawn)
        .sort(
          (a, b) =>
            reopened[registered.indexOf(a)]! - reopened[registered.indexOf(b)]!,
        );
      expect(await seedsOf(remaining)).toEqual([1, 2, 3, 4]);
      expect(await drawnTeams(t.id)).toEqual([...remaining].sort());
    });

    it("undoes the draft around a seed of 0 instead of failing the reopen", async () => {
      const t = await openTournament({
        registrationType: "both",
        maxTeams: 16,
      });
      const registered: Array<string> = [];
      for (let i = 0; i < 4; i++) {
        const [owner, member] = await fx.players(2);
        registered.push(await registerTeam(t.id, owner, [owner, member]));
      }
      await joinAll(t.id, await fx.players(2));
      await setStatus(t.id, t.organizer, "RegistrationClosed");
      const [pickup] = await pickupTeams(t.id);

      await postgres.query(
        "UPDATE tournament_teams SET seed = NULL WHERE tournament_id = $1",
        [t.id],
      );
      const draw: Array<[string, number]> = [
        [registered[0], 0],
        [registered[1], 1],
        [registered[2], 2],
        [registered[3], 3],
        [pickup.id, 4],
      ];
      for (const [teamId, seed] of draw) {
        await postgres.query(
          "UPDATE tournament_teams SET seed = $2 WHERE id = $1",
          [teamId, seed],
        );
      }

      await setStatus(t.id, t.organizer, "RegistrationOpen");

      expect(await seedsOf(registered)).toEqual([1, 2, 3, 4]);
    });

    it("keeps an organizer's seed order through the undo, and an unseeded team unseeded", async () => {
      const t = await openTournament({
        registrationType: "both",
        maxTeams: 16,
      });
      const registered: Array<string> = [];
      for (let i = 0; i < 4; i++) {
        const [owner, member] = await fx.players(2);
        registered.push(await registerTeam(t.id, owner, [owner, member]));
      }
      const recruiting = await fx.player();
      const short = await registerTeam(t.id, recruiting, [recruiting]);
      await joinAll(t.id, await fx.players(8));

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      const pickups = (await pickupTeams(t.id)).map((team) => team.id);
      expect(pickups).toHaveLength(4);
      expect(await seedsOf([short])).toEqual([null]);

      await postgres.query(
        "UPDATE tournament_teams SET seed = NULL WHERE tournament_id = $1",
        [t.id],
      );
      const draw: Array<[string, number]> = [
        [registered[0], 8],
        [registered[1], 2],
        [registered[2], 6],
        [registered[3], 4],
        [pickups[0], 1],
        [pickups[1], 3],
        [pickups[2], 5],
        [pickups[3], 7],
      ];
      for (const [teamId, seed] of draw) {
        await postgres.query(
          "UPDATE tournament_teams SET seed = $2 WHERE id = $1",
          [teamId, seed],
        );
      }

      await setStatus(t.id, t.organizer, "RegistrationOpen");

      expect(await seedsOf([...registered, short])).toEqual([4, 1, 3, 2, null]);

      await setStatus(t.id, t.organizer, "RegistrationClosed");

      expect(await seedsOf(registered)).toEqual([4, 1, 3, 2]);
    });

    // A pickup captain's invite or an organizer's hand placement puts a player
    // on the roster with no pool row, so the team's delete would take them out
    // of the tournament without a word.
    it("keeps a player placed on a pickup team in the pool, queued from when they joined it", async () => {
      const t = await openTournament();
      await postgres.query(
        `UPDATE match_options SET number_of_substitutes = 1
          WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [t.id],
      );
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const [team] = await pickupTeams(t.id);
      const placed = await fx.player();
      await addToRoster(t.id, team.id, placed);
      expect(await agentRow(t.id, placed)).toBeUndefined();

      const late = await fx.player();
      await join(t.id, late);
      expect(await statusOf(t.id, late)).toBe("waitlisted");

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      const row = await agentRow(t.id, placed);
      expect(row?.status).toBe("registered");
      expect(row?.tournament_team_id).toBeNull();
      expect(row.created_at.getTime()).toBeLessThan(
        (await agentRow(t.id, late)).created_at.getTime(),
      );
    });

    // A withdrawn row the organizer's re-placement left behind would collide
    // with the new entry on the pool's (tournament, player) key and fail the
    // reopen; a player who no longer qualifies cannot hold an entry at all.
    it("brings back a withdrawn player placed again by hand, but not one who no longer qualifies", async () => {
      const t = await openTournament();
      await postgres.query(
        `UPDATE match_options SET number_of_substitutes = 1
          WHERE id = (SELECT match_options_id FROM tournaments WHERE id = $1)`,
        [t.id],
      );
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const [team] = await pickupTeams(t.id);
      const [removed] = (await rosterOf(team.id)).filter(
        (member) => member.steam_id !== team.owner_steam_id,
      );
      await postgres.query(
        `DELETE FROM tournament_team_roster
          WHERE tournament_id = $1 AND player_steam_id = $2`,
        [t.id, removed.steam_id],
      );
      expect(await statusOf(t.id, removed.steam_id)).toBe("withdrawn");
      await addToRoster(t.id, team.id, removed.steam_id);

      const lapsed = await fx.player();
      await addToRoster(t.id, team.id, lapsed);
      await postgres.query(
        "UPDATE players SET role = 'verified_user' WHERE steam_id <> $1",
        [lapsed],
      );
      await postgres.query(
        "UPDATE tournaments SET min_role = 'verified_user' WHERE id = $1",
        [t.id],
      );

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      expect(await statusOf(t.id, removed.steam_id)).toBe("registered");
      expect(await agentRow(t.id, lapsed)).toBeUndefined();
      expect(await joined(t.id, lapsed)).toBe(false);
    });

    it("keeps the seeds of a field the draft never touched", async () => {
      const t = await openTournament({
        registrationType: "both",
        maxTeams: 8,
      });
      for (let i = 0; i < 4; i++) {
        const [owner, member] = await fx.players(2);
        await registerTeam(t.id, owner, [owner, member]);
      }
      const seeds = () =>
        postgres.query<Array<{ id: string; seed: number | null }>>(
          "SELECT id, seed FROM tournament_teams WHERE tournament_id = $1 ORDER BY id",
          [t.id],
        );

      await setStatus(t.id, t.organizer, "RegistrationClosed");
      const drawn = await seeds();
      expect(drawn.every((team) => team.seed !== null)).toBe(true);

      await setStatus(t.id, t.organizer, "RegistrationOpen");
      expect(await seeds()).toEqual(drawn);
    });

    // Reopening undoes the draft, so the pickup teams it made cannot be what
    // fills the bracket. A field of registered teams still can.
    it("reopens a field only its pickup teams filled", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(8));
      await setStatus(t.id, t.organizer, "RegistrationClosed");
      expect(await pickupTeams(t.id)).toHaveLength(4);

      await setStatus(t.id, t.organizer, "RegistrationOpen");
      expect(await pickupTeams(t.id)).toEqual([]);

      const full = await openTournament({ registrationType: "both" });
      for (let i = 0; i < 4; i++) {
        const [owner, member] = await fx.players(2);
        await registerTeam(full.id, owner, [owner, member]);
      }
      await setStatus(full.id, full.organizer, "RegistrationClosed");
      await expect(
        setStatus(full.id, full.organizer, "RegistrationOpen"),
      ).rejects.toThrow(/Cannot open tournament registration/i);
    });
  });

  describe("an organizer managing the pool", () => {
    const staff = (steamId: string, role = "user") =>
      ({ steam_id: steamId, name: "Organizer", role }) as never;

    const add = (
      tournamentId: string,
      actor: string,
      steamId: string,
      role = "user",
    ) =>
      controller().addTournamentFreeAgent({
        user: staff(actor, role),
        tournament_id: tournamentId,
        steam_id: steamId,
      });

    const remove = (tournamentId: string, actor: string, steamId: string) =>
      controller().removeTournamentFreeAgent({
        user: staff(actor),
        tournament_id: tournamentId,
        steam_id: steamId,
      });

    it("lets the organizer and a co-organizer add and remove players before the draft and during check-in review", async () => {
      const t = await createTournament({
        columns: { check_in_required: true },
      });
      const coOrganizer = await fx.player();
      await postgres.query(
        "INSERT INTO tournament_organizers (tournament_id, steam_id) VALUES ($1, $2)",
        [t.id, coOrganizer],
      );

      for (const status of ["Setup", "RegistrationOpen", "CheckInReview"]) {
        if (status !== "Setup") {
          await setStatus(t.id, t.organizer, status);
        }

        for (const actor of [t.organizer, coOrganizer]) {
          const agent = await fx.player();

          await expect(add(t.id, actor, agent)).resolves.toEqual({
            success: true,
          });
          expect(await statusOf(t.id, agent)).toBe("registered");

          await expect(remove(t.id, actor, agent)).resolves.toEqual({
            success: true,
          });
          expect(await agentRow(t.id, agent)).toBeUndefined();
        }
      }
    });

    it("leaves the pool alone once registration has closed, and once the tournament is live", async () => {
      const t = await openTournament();
      const players = await fx.players(9);
      await joinAll(t.id, players);
      const waitlisted = players[8];

      for (const status of ["RegistrationClosed", "Live"]) {
        await setStatus(t.id, t.organizer, status);
        const [tournament] = await postgres.query<Array<{ status: string }>>(
          "SELECT status FROM tournaments WHERE id = $1",
          [t.id],
        );
        expect(tournament.status).toBe(status);
        expect(await statusOf(t.id, waitlisted)).toBe("waitlisted");

        const outsider = await fx.player();
        await expect(add(t.id, t.organizer, outsider)).rejects.toThrow(
          /free agent pool/i,
        );
        expect(await agentRow(t.id, outsider)).toBeUndefined();

        await expect(remove(t.id, t.organizer, waitlisted)).rejects.toThrow(
          /free agent pool/i,
        );
        expect(await statusOf(t.id, waitlisted)).toBe("waitlisted");
      }
    });

    it("refuses anyone who does not organize this tournament", async () => {
      const t = await openTournament();
      const other = await openTournament();
      const [stranger, agent, waiting] = await fx.players(3);
      await join(t.id, waiting);

      for (const actor of [stranger, other.organizer, waiting]) {
        await expect(add(t.id, actor, agent)).rejects.toThrow(/organizer/i);
        await expect(remove(t.id, actor, waiting)).rejects.toThrow(
          /organizer/i,
        );
      }

      expect(await agentRow(t.id, agent)).toBeUndefined();
      expect(await statusOf(t.id, waiting)).toBe("registered");
    });

    it("keeps a drafted player on their pickup team", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const drafted = await nonOwner(t.id);
      const team = await teamOf(t.id, drafted);

      await expect(remove(t.id, t.organizer, drafted)).rejects.toThrow(
        /registered or waitlisted/i,
      );
      expect(await statusOf(t.id, drafted)).toBe("drafted");
      expect(await teamOf(t.id, drafted)).toBe(team);
    });

    it("holds an added player to the entry requirements", async () => {
      const t = await openTournament({
        columns: { min_role: "verified_user" },
      });
      const agent = await fx.player();

      await expect(add(t.id, t.organizer, agent)).rejects.toThrow(
        /entry requirements/i,
      );
      expect(await agentRow(t.id, agent)).toBeUndefined();

      await postgres.query(
        "UPDATE players SET role = 'verified_user' WHERE steam_id = $1",
        [agent],
      );
      await add(t.id, t.organizer, agent);
      expect(await statusOf(t.id, agent)).toBe("registered");
    });

    it("never puts a player in the tournament twice", async () => {
      const t = await openTournament({ registrationType: "both" });
      const [owner, member, agent] = await fx.players(3);
      await registerTeam(t.id, owner, [owner, member]);
      await join(t.id, agent);

      await expect(add(t.id, t.organizer, member)).rejects.toThrow(
        /already on a team/i,
      );
      await expect(add(t.id, t.organizer, owner)).rejects.toThrow(
        /already have a team/i,
      );
      await expect(add(t.id, t.organizer, agent)).rejects.toThrow(
        /already in/i,
      );

      expect(await agentRow(t.id, member)).toBeUndefined();
      expect(await agentRow(t.id, owner)).toBeUndefined();
      expect(await statusOf(t.id, agent)).toBe("registered");
    });

    it("refuses a player who blocked the organizer, but not staff", async () => {
      const t = await openTournament();
      const [blocker, admin] = await fx.players(2);

      for (const blocked of [t.organizer, admin]) {
        await postgres.query(
          "INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id) VALUES ($1, $2)",
          [blocker, blocked],
        );
      }

      await expect(add(t.id, t.organizer, blocker)).rejects.toThrow(
        /player_blocked/,
      );
      expect(await agentRow(t.id, blocker)).toBeUndefined();

      await add(t.id, admin, blocker, "administrator");
      expect(await statusOf(t.id, blocker)).toBe("registered");
    });

    it("waitlists a player added after the draft and promotes them into the next open slot", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const late = await fx.player();
      await add(t.id, t.organizer, late);
      expect(await statusOf(t.id, late)).toBe("waitlisted");

      const drafted = await nonOwner(t.id);
      const team = await teamOf(t.id, drafted);
      await leave(t.id, drafted);

      expect(await statusOf(t.id, late)).toBe("drafted");
      expect(await teamOf(t.id, late)).toBe(team);
    });

    it("takes a removed player off the waitlist and promotes the one behind them", async () => {
      const t = await openTournament();
      await joinAll(t.id, await fx.players(4));
      await draft(t);

      const [first, second] = await fx.players(2);
      await joinAll(t.id, [first, second]);
      expect(await statusOf(t.id, first)).toBe("waitlisted");
      expect(await statusOf(t.id, second)).toBe("waitlisted");

      await remove(t.id, t.organizer, first);
      expect(await agentRow(t.id, first)).toBeUndefined();

      const drafted = await nonOwner(t.id);
      const team = await teamOf(t.id, drafted);
      await leave(t.id, drafted);
      expect(await teamOf(t.id, second)).toBe(team);

      await join(t.id, first);
      expect(await statusOf(t.id, first)).toBe("waitlisted");
    });

    describe("checking in", () => {
      const reviewedTournament = () =>
        openTournament({ columns: { check_in_required: true } });

      const closeReview = async (tournamentId: string, organizer: string) => {
        await setStatus(tournamentId, organizer, "CheckInReview");
        await postgres.query(
          "UPDATE tournaments SET check_in_ends_at = now() - interval '1 minute' WHERE id = $1",
          [tournamentId],
        );
      };

      it("counts a player added during check-in review as checked in", async () => {
        const t = await reviewedTournament();
        await closeReview(t.id, t.organizer);

        const added = await fx.player();
        await add(t.id, t.organizer, added);

        const [row] = await postgres.query<
          Array<{ status: string; checked_in_at: Date | null }>
        >(
          `SELECT status, checked_in_at FROM tournament_free_agents
            WHERE tournament_id = $1 AND player_steam_id = $2`,
          [t.id, added],
        );
        expect(row.status).toBe("registered");
        expect(row.checked_in_at).not.toBeNull();
      });

      it("promotes a player added during check-in review into an open pickup slot", async () => {
        const t = await reviewedTournament();
        await joinAll(t.id, await fx.players(4));
        await draft(t);

        const drafted = await nonOwner(t.id);
        const team = await teamOf(t.id, drafted);
        await leave(t.id, drafted);
        await closeReview(t.id, t.organizer);

        const added = await fx.player();
        await add(t.id, t.organizer, added);

        expect(await statusOf(t.id, added)).toBe("drafted");
        expect(await teamOf(t.id, added)).toBe(team);
      });
    });

    describe("racing a Draft Teams", () => {
      const openSession = () =>
        (postgres as unknown as { pool: Pool }).pool.connect();

      const lockWaits = async () => {
        const [row] = await postgres.query<Array<{ waiting: number }>>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        return row.waiting;
      };

      const blockedOrSettled = async (pending: Promise<unknown>) => {
        let settled = false;
        pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        for (let attempt = 0; attempt < 100 && !settled; attempt++) {
          if ((await lockWaits()) > 0) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };

      it("waits for a draft in flight, so the added player is waitlisted behind its teams", async () => {
        const t = await openTournament();
        await joinAll(t.id, await fx.players(4));
        const late = await fx.player();

        const drafting = await openSession();
        try {
          await drafting.query("BEGIN");
          await drafting.query("SELECT draft_tournament_free_agent_teams($1)", [
            t.id,
          ]);

          const adding = add(t.id, t.organizer, late);
          await blockedOrSettled(adding);
          await drafting.query("COMMIT");
          await adding;
        } finally {
          await drafting.query("ROLLBACK");
          drafting.release();
        }

        expect(await pickupTeams(t.id)).toHaveLength(2);
        expect(await statusOf(t.id, late)).toBe("waitlisted");
      });

      it("holds a draft until a removal in flight commits, so it never rosters the removed player", async () => {
        const t = await openTournament();
        const players = await fx.players(5);
        await joinAll(t.id, players);
        const removed = players[0];

        let reachCommit!: () => void;
        const atCommit = new Promise<void>((resolve) => {
          reachCommit = resolve;
        });
        let releaseCommit!: () => void;
        const commit = new Promise<void>((resolve) => {
          releaseCommit = resolve;
        });
        const paused = new TournamentsController(
          new Logger("TournamentFreeAgentFlowTest"),
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          notifications as never,
          {
            query: postgres.query.bind(postgres),
            transaction: (
              fn: (client: unknown) => Promise<unknown>,
              session?: string,
            ) =>
              postgres.transaction(async (client) => {
                const result = await fn(client);
                reachCommit();
                await commit;
                return result;
              }, session),
          } as never,
          { getConnection: () => ({}) } as never,
        );

        const removing = paused.removeTournamentFreeAgent({
          user: staff(t.organizer),
          tournament_id: t.id,
          steam_id: removed,
        });
        await atCommit;

        const drafting = draft(t);
        await blockedOrSettled(drafting);
        releaseCommit();
        await removing;
        await drafting;

        expect(await agentRow(t.id, removed)).toBeUndefined();
        expect(await teamOf(t.id, removed)).toBeNull();
        expect(await pickupTeams(t.id)).toHaveLength(2);
      });
    });

    // A transaction-local hasura.user on a connection that never had one falls
    // back to '' after COMMIT or ROLLBACK, and every later
    // current_setting('hasura.user', true)::json on it then fails. One
    // connection, so the next query is guaranteed to land on it.
    it("leaves its pooled connection with a parseable session whether the add lands or not", async () => {
      const { config } = postgres as unknown as {
        config: { connections: { default: Record<string, unknown> } };
      };
      const single = new PostgresService(
        {
          get: () => ({
            connections: { default: { ...config.connections.default, max: 1 } },
          }),
        } as never,
        new Logger("TournamentFreeAgentSingleConnection"),
      );
      const isolated = new TournamentsController(
        new Logger("TournamentFreeAgentFlowTest"),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        notifications as never,
        single,
        { getConnection: () => ({}) } as never,
      );
      const sessionParses = () =>
        single.query(
          "SELECT current_setting('hasura.user', true)::json AS session",
        );

      try {
        const t = await openTournament({
          columns: { min_role: "verified_user" },
        });
        const agent = await fx.player();

        await expect(
          isolated.addTournamentFreeAgent({
            user: staff(t.organizer),
            tournament_id: t.id,
            steam_id: agent,
          }),
        ).rejects.toThrow(/entry requirements/i);
        await expect(sessionParses()).resolves.toBeDefined();

        await postgres.query(
          "UPDATE players SET role = 'verified_user' WHERE steam_id = $1",
          [agent],
        );
        await isolated.addTournamentFreeAgent({
          user: staff(t.organizer),
          tournament_id: t.id,
          steam_id: agent,
        });
        await expect(sessionParses()).resolves.toBeDefined();
      } finally {
        await endPool(single);
      }
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
