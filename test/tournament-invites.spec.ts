import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { InvitesController } from "./../src/invites/invites.controller";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// tournament_invites is the half of invite_only that names who is wanted: an
// invite link is a shortcut, an invite is an address. It is addressed to a
// player or to a team -- tournaments recruit teams -- and accepting writes the
// same tournament_registration_unlocks row a redeemed link writes, so every
// path meets at one grant the join triggers already check.
describe("tournament invites (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const notifications = { notifyPlayers: jest.fn() };

  const controller = () =>
    new InvitesController(
      new Logger("TournamentInvitesTest"),
      {} as never,
      postgres,
      notifications as never,
    );

  const asUser = (steamId: string): User => ({
    name: "Player",
    role: "user",
    steam_id: steamId,
  });

  beforeAll(async () => {
    db = await bootMigratedDb("TournamentInvitesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561193600000000n);
    await fx.region("TestInv");
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

  const createTournament = async ({
    columns = {} as Record<string, string | number | boolean>,
  } = {}) => {
    const organizer = await fx.player();
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions, number_of_substitutes)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestInv}', 0
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
    );

    const names = Object.keys(columns);
    const extraCols = names.map((name) => `, "${name}"`).join("");
    const extraVals = names.map((_, index) => `, $${index + 4}`).join("");

    const [tournament] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status${extraCols})
       VALUES ($1, now() + interval '1 day', $2, $3, 'Setup'${extraVals}) RETURNING id`,
      [
        fx.nextName("cup"),
        organizer,
        options.id,
        ...names.map((name) => columns[name]),
      ],
    );
    await postgres.query(
      `INSERT INTO tournament_stages (tournament_id, type, "order", min_teams, max_teams)
       VALUES ($1, 'SingleElimination', 1, 4, 8)`,
      [tournament.id],
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

  // Registration only closes out of RegistrationOpen, so the window is walked
  // rather than jumped. Read back because 'Live' and a short roster can land
  // the tournament somewhere else entirely, and a test asserting against the
  // wrong status proves nothing.
  const closeRegistration = async (tournamentId: string, actor: string) => {
    await setStatus(tournamentId, actor, "RegistrationOpen");
    await setStatus(tournamentId, actor, "RegistrationClosed");

    const [row] = await postgres.query<Array<{ status: string }>>(
      "SELECT status FROM tournaments WHERE id = $1",
      [tournamentId],
    );
    expect(row.status).toBe("RegistrationClosed");
  };

  // The invite arrives as a plain GraphQL insert from the organizer's session,
  // which is the only path the trigger guard has to answer for.
  const invite = (
    tournamentId: string,
    steamId: string,
    actor: string,
    role = "user",
  ) =>
    runAsUser(postgres, actor, role, async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_invites (tournament_id, steam_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [tournamentId, steamId, actor],
      )) as Array<{ id: string }>;
      return row.id;
    });

  const inviteCount = async (tournamentId: string) => {
    const [row] = await postgres.query<Array<{ count: string }>>(
      "SELECT count(*)::text AS count FROM tournament_invites WHERE tournament_id = $1",
      [tournamentId],
    );
    return Number(row.count);
  };

  const unlocked = async (tournamentId: string, steamId: string) => {
    const [row] = await postgres.query<Array<{ unlocked: boolean }>>(
      "SELECT tournament_registration_unlocked($1, $2) AS unlocked",
      [tournamentId, steamId],
    );
    return row.unlocked;
  };

  const registerTeam = (tournamentId: string, owner: string) =>
    runAsUser(postgres, owner, "user", (query) =>
      query(
        `INSERT INTO tournament_teams (tournament_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, $2, $3, $3)`,
        [tournamentId, fx.nextName("pickup"), owner],
      ),
    );

  // The invite arrives the same way a player invite does; only the address
  // column changes.
  const inviteTeam = (tournamentId: string, teamId: string, actor: string) =>
    runAsUser(postgres, actor, "user", async (query) => {
      const [row] = (await query(
        `INSERT INTO tournament_invites (tournament_id, team_id, invited_by_player_steam_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [tournamentId, teamId, actor],
      )) as Array<{ id: string }>;
      return row.id;
    });

  const registerRealTeam = (
    tournamentId: string,
    teamId: string,
    actor: string,
  ) =>
    runAsUser(postgres, actor, "user", (query) =>
      query(
        `INSERT INTO tournament_teams (tournament_id, team_id, name, owner_steam_id, captain_steam_id)
         VALUES ($1, $2, $3, $4, $4)`,
        [tournamentId, teamId, fx.nextName("squad"), actor],
      ),
    );

  const registerFreeAgent = (tournamentId: string, steamId: string) =>
    runAsUser(postgres, steamId, "user", (query) =>
      query(
        `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
         VALUES ($1, $2)`,
        [tournamentId, steamId],
      ),
    );

  describe("creating an invite", () => {
    it("lets the tournament's own organizer invite a player", async () => {
      const t = await createTournament();
      const player = await fx.player();

      const id = await invite(t.id, player, t.organizer);

      expect(id).toBeTruthy();
      expect(await inviteCount(t.id)).toBe(1);
    });

    it("lets the tournament_organizer role invite for a tournament it does not own", async () => {
      const t = await createTournament();
      const staff = await fx.player();
      const player = await fx.player();

      await invite(t.id, player, staff, "tournament_organizer");

      expect(await inviteCount(t.id)).toBe(1);
    });

    it("refuses an invite from a player who does not run the tournament", async () => {
      const t = await createTournament();
      const outsider = await fx.player();
      const player = await fx.player();

      await expect(invite(t.id, player, outsider)).rejects.toThrow(
        /organizer can invite/i,
      );
    });

    it("keeps one invite per player per tournament", async () => {
      const t = await createTournament();
      const player = await fx.player();
      await invite(t.id, player, t.organizer);

      await expect(invite(t.id, player, t.organizer)).rejects.toThrow(
        /duplicate key/i,
      );
    });

    // invite_only says who may ENTER, not whether an organizer may recruit. An
    // open tournament is invitable too -- an invite is how an organizer asks a
    // particular team to come, whatever the door policy is.
    it.each([true, false])(
      "invites a player whether or not the tournament is invite only (%s)",
      async (invite_only) => {
        const t = await createTournament({ columns: { invite_only } });

        await expect(
          invite(t.id, await fx.player(), t.organizer),
        ).resolves.toBeTruthy();
      },
    );

    it("invites once registration has opened", async () => {
      const t = await createTournament();
      await setStatus(t.id, t.organizer, "RegistrationOpen");

      await expect(
        invite(t.id, await fx.player(), t.organizer),
      ).resolves.toBeTruthy();
    });

    // Same window the invite links use. Past it there is nothing to invite
    // somebody into: what an accepted invite writes is a registration unlock,
    // and the bracket has already been drawn off the teams that registered.
    it("refuses an invite once registration has closed", async () => {
      const t = await createTournament();
      await closeRegistration(t.id, t.organizer);

      await expect(
        invite(t.id, await fx.player(), t.organizer),
      ).rejects.toThrow(/registration is closed/i);
      expect(await inviteCount(t.id)).toBe(0);
    });

    it("refuses a team invite once registration has closed", async () => {
      const t = await createTournament();
      const team = await fx.team();
      await closeRegistration(t.id, t.organizer);

      await expect(inviteTeam(t.id, team.id, t.organizer)).rejects.toThrow(
        /registration is closed/i,
      );
      expect(await inviteCount(t.id)).toBe(0);
    });

    it("does not survive its tournament", async () => {
      const t = await createTournament();
      await invite(t.id, await fx.player(), t.organizer);

      await postgres.query("DELETE FROM tournaments WHERE id = $1", [t.id]);

      const [row] = await postgres.query<Array<{ count: string }>>(
        "SELECT count(*)::text AS count FROM tournament_invites",
      );
      expect(Number(row.count)).toBe(0);
    });
  });

  describe("accepting and denying", () => {
    it("grants registration access and consumes the invite", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      const player = await fx.player();
      const id = await invite(t.id, player, t.organizer);

      const result = await controller().acceptInvite({
        user: asUser(player),
        invite_id: id,
        type: "tournament-registration",
      });

      expect(result).toEqual({ success: true });
      expect(await unlocked(t.id, player)).toBe(true);
      expect(await inviteCount(t.id)).toBe(0);
    });

    it("stays a no-op when the player already redeemed a link", async () => {
      const t = await createTournament({
        columns: { invite_only: true },
      });
      const player = await fx.player();
      await postgres.query(
        `INSERT INTO tournament_registration_unlocks (tournament_id, player_steam_id)
         VALUES ($1, $2)`,
        [t.id, player],
      );
      const id = await invite(t.id, player, t.organizer);

      await expect(
        controller().acceptInvite({
          user: asUser(player),
          invite_id: id,
          type: "tournament-registration",
        }),
      ).resolves.toEqual({ success: true });
      expect(await unlocked(t.id, player)).toBe(true);
    });

    // An invite outlives the window it was sent in, so closing registration has
    // to be answered at the other door too: accepting writes the unlock row,
    // and writing one for an already-seeded bracket is what this stops.
    it("refuses an accept once registration has closed", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      const player = await fx.player();
      const id = await invite(t.id, player, t.organizer);
      await closeRegistration(t.id, t.organizer);

      await expect(
        controller().acceptInvite({
          user: asUser(player),
          invite_id: id,
          type: "tournament-registration",
        }),
      ).rejects.toThrow(/^invite_registration_closed$/);

      expect(await unlocked(t.id, player)).toBe(false);
      expect(await inviteCount(t.id)).toBe(1);
    });

    // Declining is not registering. Somebody who is never going to play should
    // be able to clear the invite off their bell whenever they get to it.
    it("still lets the invitee decline once registration has closed", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      const player = await fx.player();
      const id = await invite(t.id, player, t.organizer);
      await closeRegistration(t.id, t.organizer);

      await expect(
        controller().denyInvite({
          user: asUser(player),
          invite_id: id,
          type: "tournament-registration",
        }),
      ).resolves.toEqual({ success: true });
      expect(await inviteCount(t.id)).toBe(0);
    });

    it("refuses to let anyone but the invitee accept", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      const player = await fx.player();
      const thief = await fx.player();
      const id = await invite(t.id, player, t.organizer);

      const result = await controller().acceptInvite({
        user: asUser(thief),
        invite_id: id,
        type: "tournament-registration",
      });

      expect(result).toEqual({ success: false });
      expect(await unlocked(t.id, thief)).toBe(false);
      expect(await inviteCount(t.id)).toBe(1);
    });

    it("drops the invite on deny and grants nothing", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      const player = await fx.player();
      const id = await invite(t.id, player, t.organizer);

      const result = await controller().denyInvite({
        user: asUser(player),
        invite_id: id,
        type: "tournament-registration",
      });

      expect(result).toEqual({ success: true });
      expect(await inviteCount(t.id)).toBe(0);
      expect(await unlocked(t.id, player)).toBe(false);
    });

    // The dispatch used to treat everything that was not "team" as a
    // tournament-team invite, so a typo silently looked up the wrong table.
    it("refuses an invite type it does not know", async () => {
      await expect(
        controller().acceptInvite({
          user: asUser(await fx.player()),
          invite_id: "00000000-0000-0000-0000-000000000000",
          type: "tournament-registrations",
        }),
      ).rejects.toThrow(/unknown invite type/i);

      await expect(
        controller().denyInvite({
          user: asUser(await fx.player()),
          invite_id: "00000000-0000-0000-0000-000000000000",
          type: "nope",
        }),
      ).rejects.toThrow(/unknown invite type/i);
    });

    it("notifies the invited player", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      const player = await fx.player();
      const id = await invite(t.id, player, t.organizer);

      await controller().tournament_invite_events({
        op: "INSERT",
        old: { id },
        new: { id },
      });

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "TournamentInvite",
        expect.objectContaining({ entity_id: id, steamIds: [player] }),
      );
    });
  });

  describe("inviting a team", () => {
    it("lets the invited team register once an admin accepts", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const team = await fx.team();

      await expect(registerRealTeam(t.id, team.id, team.owner)).rejects.toThrow(
        /invite only/i,
      );

      const id = await inviteTeam(t.id, team.id, t.organizer);
      await expect(
        controller().acceptInvite({
          user: asUser(team.owner),
          invite_id: id,
          type: "tournament-registration",
        }),
      ).resolves.toEqual({ success: true });

      await expect(
        registerRealTeam(t.id, team.id, team.owner),
      ).resolves.toBeDefined();
    });

    // The team was invited, not its players individually. A free-agent slot is
    // a different thing to have been offered.
    it("does not put the accepting admin into the free agent pool", async () => {
      const t = await createTournament({
        columns: { invite_only: true, registration_type: "both" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const team = await fx.team();

      const id = await inviteTeam(t.id, team.id, t.organizer);
      await controller().acceptInvite({
        user: asUser(team.owner),
        invite_id: id,
        type: "tournament-registration",
      });

      await expect(registerFreeAgent(t.id, team.owner)).rejects.toThrow(
        /invite only/i,
      );
    });

    // A team-scoped grant is not a personal one: the same admin bringing a
    // different team is still outside.
    it("does not let the accepting admin register some other team", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const invited = await fx.team();
      const [other] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO teams (name, short_name, owner_steam_id) VALUES ($1, $1, $2) RETURNING id",
        [fx.nextName("other"), invited.owner],
      );

      const id = await inviteTeam(t.id, invited.id, t.organizer);
      await controller().acceptInvite({
        user: asUser(invited.owner),
        invite_id: id,
        type: "tournament-registration",
      });

      await expect(
        registerRealTeam(t.id, other.id, invited.owner),
      ).rejects.toThrow(/invite only/i);
    });

    it("refuses an accept from somebody who cannot register the team", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      const team = await fx.team();
      const outsider = await fx.player();
      const id = await inviteTeam(t.id, team.id, t.organizer);

      await expect(
        controller().acceptInvite({
          user: asUser(outsider),
          invite_id: id,
          type: "tournament-registration",
        }),
      ).resolves.toEqual({ success: false });
      expect(await inviteCount(t.id)).toBe(1);
    });

    // num_nonnulls(steam_id, team_id) = 1: an invite has exactly one address.
    it("refuses a row addressed to both a player and a team, or to neither", async () => {
      const t = await createTournament();
      const team = await fx.team();
      const player = await fx.player();

      await expect(
        runAsUser(postgres, t.organizer, "user", (query) =>
          query(
            `INSERT INTO tournament_invites (tournament_id, steam_id, team_id, invited_by_player_steam_id)
             VALUES ($1, $2, $3, $4)`,
            [t.id, player, team.id, t.organizer],
          ),
        ),
      ).rejects.toThrow(/addressed_once/i);

      await expect(
        runAsUser(postgres, t.organizer, "user", (query) =>
          query(
            `INSERT INTO tournament_invites (tournament_id, invited_by_player_steam_id)
             VALUES ($1, $2)`,
            [t.id, t.organizer],
          ),
        ),
      ).rejects.toThrow(/addressed_once/i);
    });

    // A plain UNIQUE stops deduping the moment the other half can be NULL.
    it("keeps one invite per team per tournament", async () => {
      const t = await createTournament();
      const team = await fx.team();
      await inviteTeam(t.id, team.id, t.organizer);

      await expect(inviteTeam(t.id, team.id, t.organizer)).rejects.toThrow(
        /duplicate key/i,
      );
    });

    it("notifies whoever could register the invited team", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      const team = await fx.team();
      const id = await inviteTeam(t.id, team.id, t.organizer);

      await controller().tournament_invite_events({
        op: "INSERT",
        old: { id },
        new: { id },
      });

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "TournamentInvite",
        expect.objectContaining({
          entity_id: id,
          steamIds: expect.arrayContaining([team.owner]),
        }),
      );
    });
  });

  describe("registering into an invite-only tournament", () => {
    it("lets an invited player register a team once they accept", async () => {
      const t = await createTournament({ columns: { invite_only: true } });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const player = await fx.player();

      await expect(registerTeam(t.id, player)).rejects.toThrow(/invite only/i);

      const id = await invite(t.id, player, t.organizer);
      await controller().acceptInvite({
        user: asUser(player),
        invite_id: id,
        type: "tournament-registration",
      });

      await expect(registerTeam(t.id, player)).resolves.toBeDefined();
    });

    // Same unlock row, other join path: an invite has to work for a player who
    // brings no team at all.
    it("lets an invited player join the free agent pool once they accept", async () => {
      const t = await createTournament({
        columns: { invite_only: true, registration_type: "free_agents" },
      });
      await setStatus(t.id, t.organizer, "RegistrationOpen");
      const player = await fx.player();

      await expect(registerFreeAgent(t.id, player)).rejects.toThrow(
        /invite only/i,
      );

      const id = await invite(t.id, player, t.organizer);
      await controller().acceptInvite({
        user: asUser(player),
        invite_id: id,
        type: "tournament-registration",
      });

      await expect(registerFreeAgent(t.id, player)).resolves.toBeDefined();
    });
  });
});
