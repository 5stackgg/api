import { TournamentsController } from "./tournaments.controller";
import { User } from "../auth/types/User";

// The registration/check-in actions are the ONLY thing enforcing check_in_setting,
// invite_only and organizer-ness: their writes run on a pooled connection with no
// hasura.user, which every SQL guard treats as an internal write. The mock routes
// on the statement so a query moving between methods does not rewrite the test.
type Rows = Array<Record<string, unknown>>;

describe("TournamentsController registration and check-in actions", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const hasura = { query: jest.fn(), mutation: jest.fn() };
  const demoMetadata = { deleteDemosForMatch: jest.fn() };
  const clips = { deleteClipsForMatch: jest.fn() };
  const tournamentVoice = {};
  const notifications = { notifyPlayers: jest.fn() };
  const postgres = { query: jest.fn() };
  const redisExec = jest.fn();
  const redis = {
    multi: () => ({
      incr: () => ({ expire: () => ({ exec: redisExec }) }),
    }),
  };
  const redisManager = { getConnection: () => redis };

  let controller: TournamentsController;
  let tournamentRow: Record<string, unknown> | undefined;
  let teamRow: Record<string, unknown> | undefined;
  let rosterStamped: Rows;
  let freeAgentStamped: Rows;
  let teamStamped: Rows;
  let extended: Rows;
  let continued: Rows;
  let removedFreeAgent: Rows;
  let eligible: boolean;
  let mintedCode: Record<string, unknown>;
  let codeRow: Record<string, unknown> | undefined;
  let claimedRows: Rows;
  let diagnosisRow: Record<string, unknown> | undefined;
  let draftedTeams: number;
  let lobbyRow: Record<string, unknown> | undefined;
  let lobbyMembers: Rows;
  let sizingRow: Record<string, unknown> | undefined;
  let statements: Array<string>;

  const player: User = {
    name: "Player",
    role: "user",
    steam_id: "76561190000000001",
  };

  const organizer: User = {
    name: "Organizer",
    role: "user",
    steam_id: "76561190000000099",
  };

  const friend: User = {
    name: "Friend",
    role: "user",
    steam_id: "76561190000000002",
  };

  const lobbyMember = (overrides: Record<string, unknown> = {}) => ({
    steam_id: friend.steam_id,
    name: "Friend",
    eligible: true,
    unlocked: true,
    rostered: false,
    owns_team: false,
    pool_status: null as string | null,
    ...overrides,
  });

  const tournament = (overrides: Record<string, unknown> = {}) => ({
    id: "tournament-1",
    name: "Cup",
    status: "RegistrationOpen",
    start: new Date(Date.now() + 3_600_000).toISOString(),
    banner: null as string | null,
    logo: null as string | null,
    organizer_steam_id: organizer.steam_id,
    registration_type: "teams",
    invite_only: false,
    check_in_required: true,
    check_in_setting: "Captains",
    check_in_open: true,
    is_organizer: false,
    unlocked: false,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    redisExec.mockResolvedValue([[null, 1]]);
    tournamentRow = tournament();
    teamRow = { id: "team-1", can_manage: false, is_captain: false };
    rosterStamped = [];
    freeAgentStamped = [];
    teamStamped = [{ id: "team-1" }];
    extended = [{ id: "tournament-1" }];
    continued = [{ id: "tournament-1" }];
    removedFreeAgent = [{ id: "agent-1" }];
    eligible = true;
    mintedCode = { id: "code-1", code: "ABCDEFGHJK" };
    codeRow = { tournament_id: "tournament-1" };
    claimedRows = [{ invite_code_id: "code-1" }];
    diagnosisRow = undefined;
    draftedTeams = 2;
    lobbyRow = { lobby_id: "lobby-1", captain: true };
    lobbyMembers = [
      lobbyMember({ steam_id: player.steam_id, name: "Player" }),
      lobbyMember({ steam_id: friend.steam_id, name: "Friend" }),
    ];
    sizingRow = { team_size: 5, carried_over: "0" };
    statements = [];

    postgres.query.mockImplementation(async (sql: string) => {
      statements.push(sql);

      // Before the generic routes: the lobby member lookup resolves every gate
      // in one statement, so it matches several of them.
      if (sql.includes("FROM lobby_players lp")) {
        return lobbyMembers;
      }
      if (sql.includes("FROM lobby_players")) {
        return lobbyRow ? [lobbyRow] : [];
      }
      if (sql.includes("tournament_min_players_per_lineup")) {
        return sizingRow ? [sizingRow] : [];
      }
      if (sql.includes("is_tournament_organizer(t, $2::json)")) {
        return tournamentRow ? [tournamentRow] : [];
      }
      if (sql.includes("can_manage_tournament_team")) {
        return teamRow ? [teamRow] : [];
      }
      if (sql.includes("UPDATE tournament_free_agents")) {
        return freeAgentStamped;
      }
      if (sql.includes("UPDATE tournament_team_roster")) {
        return rosterStamped;
      }
      if (sql.includes("UPDATE tournament_teams")) {
        return teamStamped;
      }
      if (sql.includes("SET check_in_ends_at")) {
        return extended;
      }
      if (sql.includes("SET status = 'RegistrationClosed'")) {
        return continued;
      }
      if (sql.includes("draft_tournament_free_agent_teams")) {
        return [{ teams_created: draftedTeams }];
      }
      if (sql.includes("player_meets_tournament_requirements")) {
        return [{ ok: eligible }];
      }
      if (sql.includes("INSERT INTO tournament_free_agents")) {
        return [];
      }
      if (sql.includes("DELETE FROM tournament_free_agents")) {
        return removedFreeAgent;
      }
      if (sql.includes("INSERT INTO tournament_invite_codes")) {
        return [mintedCode];
      }
      if (sql.includes("SELECT tournament_id::text AS tournament_id")) {
        return codeRow ? [codeRow] : [];
      }
      if (sql.includes("SET revoked_at = now()")) {
        return [];
      }
      if (sql.includes("DELETE FROM tournament_invite_codes c")) {
        return [];
      }
      if (sql.includes("WITH claimed AS (")) {
        return claimedRows;
      }
      if (sql.includes("AS already_used")) {
        return diagnosisRow ? [diagnosisRow] : [];
      }
      if (sql.includes("INSERT INTO tournament_registration_unlocks")) {
        return [];
      }
      if (
        sql.includes("assign_seeds_to_teams") ||
        sql.includes("update_tournament_stages") ||
        sql.includes("seed_stage")
      ) {
        return [];
      }
      if (sql.includes("FROM tournament_team_roster ttr")) {
        return [{ steam_id: "1" }];
      }

      throw new Error(`unexpected query: ${sql}`);
    });

    controller = new TournamentsController(
      logger as any,
      hasura as any,
      demoMetadata as any,
      clips as any,
      tournamentVoice as any,
      notifications as any,
      postgres as any,
      redisManager as any,
    );
  });

  describe("checkIntoTournament", () => {
    it("refuses when the window is not open", async () => {
      tournamentRow = tournament({ check_in_open: false });

      await expect(
        controller.checkIntoTournament({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/window is not open/i);
    });

    it("refuses when the tournament does not require check-in", async () => {
      tournamentRow = tournament({ check_in_required: false });

      await expect(
        controller.checkIntoTournament({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/does not require check-in/i);
    });

    describe("Captains", () => {
      it("lets someone who can manage the team confirm it", async () => {
        teamRow = { id: "team-1", can_manage: true, is_captain: false };

        await expect(
          controller.checkIntoTournament({
            user: player,
            tournament_id: "tournament-1",
            tournament_team_id: "team-1",
          }),
        ).resolves.toEqual({ success: true });

        expect(
          statements.some((sql) => sql.includes("UPDATE tournament_teams")),
        ).toBe(true);
      });

      it("refuses a rostered player who is not the captain", async () => {
        teamRow = { id: "team-1", can_manage: false, is_captain: false };

        await expect(
          controller.checkIntoTournament({
            user: player,
            tournament_id: "tournament-1",
            tournament_team_id: "team-1",
          }),
        ).rejects.toThrow(/captain/i);
      });
    });

    describe("Players", () => {
      beforeEach(() => {
        tournamentRow = tournament({ check_in_setting: "Players" });
      });

      it("confirms only the caller's own roster row", async () => {
        rosterStamped = [{ id: "team-1" }];

        await expect(
          controller.checkIntoTournament({
            user: player,
            tournament_id: "tournament-1",
            tournament_team_id: "team-1",
          }),
        ).resolves.toEqual({ success: true });

        const stamp = statements.find((sql) =>
          sql.includes("UPDATE tournament_team_roster"),
        );
        expect(stamp).toContain("player_steam_id = $2::bigint");
        expect(
          statements.some((sql) => sql.includes("UPDATE tournament_teams")),
        ).toBe(false);
      });

      it("refuses someone who is not on the roster", async () => {
        rosterStamped = [];

        await expect(
          controller.checkIntoTournament({
            user: player,
            tournament_id: "tournament-1",
            tournament_team_id: "team-1",
          }),
        ).rejects.toThrow(/roster/i);
      });
    });

    describe("Admin", () => {
      beforeEach(() => {
        tournamentRow = tournament({ check_in_setting: "Admin" });
      });

      it("refuses a captain", async () => {
        teamRow = { id: "team-1", can_manage: true, is_captain: true };

        await expect(
          controller.checkIntoTournament({
            user: player,
            tournament_id: "tournament-1",
            tournament_team_id: "team-1",
          }),
        ).rejects.toThrow(/organizer/i);
      });

      it("lets the organizer mark a team present", async () => {
        tournamentRow = tournament({
          check_in_setting: "Admin",
          is_organizer: true,
        });

        await expect(
          controller.checkIntoTournament({
            user: organizer,
            tournament_id: "tournament-1",
            tournament_team_id: "team-1",
          }),
        ).resolves.toEqual({ success: true });
      });
    });

    it("confirms a free agent who has no team", async () => {
      freeAgentStamped = [{ id: "agent-1" }];
      teamRow = undefined;

      await expect(
        controller.checkIntoTournament({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).resolves.toEqual({ success: true });
    });

    it("refuses someone with neither a team nor a free agent row", async () => {
      teamRow = undefined;
      freeAgentStamped = [];

      await expect(
        controller.checkIntoTournament({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/not registered/i);
    });
  });

  describe("readmitTournamentTeam", () => {
    it("refuses a non-organizer", async () => {
      await expect(
        controller.readmitTournamentTeam({
          user: player,
          tournament_id: "tournament-1",
          tournament_team_id: "team-1",
        }),
      ).rejects.toThrow(/organizer/i);
    });

    it("refuses once the tournament is live", async () => {
      tournamentRow = tournament({ is_organizer: true, status: "Live" });

      await expect(
        controller.readmitTournamentTeam({
          user: organizer,
          tournament_id: "tournament-1",
          tournament_team_id: "team-1",
        }),
      ).rejects.toThrow(/live/i);
    });

    // Seeding alone leaves a re-admitted team with a seed and no bracket slot
    // once "continue without them" has already drawn the bracket, so all three
    // steps have to run -- the same sequence tau_tournaments uses.
    it("stamps the team and rebuilds the bracket around it", async () => {
      tournamentRow = tournament({ is_organizer: true });

      await expect(
        controller.readmitTournamentTeam({
          user: organizer,
          tournament_id: "tournament-1",
          tournament_team_id: "team-1",
        }),
      ).resolves.toEqual({ success: true });

      expect(
        statements.some((sql) => sql.includes("update_tournament_stages")),
      ).toBe(true);
      expect(
        statements.some((sql) => sql.includes("assign_seeds_to_teams")),
      ).toBe(true);
      expect(statements.some((sql) => sql.includes("seed_stage"))).toBe(true);
    });

    it("rebuilds the bracket after registration has already closed", async () => {
      tournamentRow = tournament({
        is_organizer: true,
        status: "RegistrationClosed",
      });

      await expect(
        controller.readmitTournamentTeam({
          user: organizer,
          tournament_id: "tournament-1",
          tournament_team_id: "team-1",
        }),
      ).resolves.toEqual({ success: true });

      expect(
        statements.some((sql) => sql.includes("update_tournament_stages")),
      ).toBe(true);
      expect(statements.some((sql) => sql.includes("seed_stage"))).toBe(true);
    });
  });

  describe("extendTournamentCheckIn", () => {
    it("refuses a non-organizer", async () => {
      tournamentRow = tournament({ status: "CheckInReview" });

      await expect(
        controller.extendTournamentCheckIn({
          user: player,
          tournament_id: "tournament-1",
          minutes: 10,
        }),
      ).rejects.toThrow(/organizer/i);
    });

    it("refuses outside check-in review", async () => {
      tournamentRow = tournament({ is_organizer: true });

      await expect(
        controller.extendTournamentCheckIn({
          user: organizer,
          tournament_id: "tournament-1",
          minutes: 10,
        }),
      ).rejects.toThrow(/check-in review/i);
    });

    it("refuses a nonsense duration", async () => {
      tournamentRow = tournament({
        is_organizer: true,
        status: "CheckInReview",
      });

      await expect(
        controller.extendTournamentCheckIn({
          user: organizer,
          tournament_id: "tournament-1",
          minutes: 0,
        }),
      ).rejects.toThrow(/1 to 240/);
    });

    it("reopens registration and re-notifies the teams that missed", async () => {
      tournamentRow = tournament({
        is_organizer: true,
        status: "CheckInReview",
      });

      await expect(
        controller.extendTournamentCheckIn({
          user: organizer,
          tournament_id: "tournament-1",
          minutes: 15,
        }),
      ).resolves.toEqual({ success: true });

      const update = statements.find((sql) =>
        sql.includes("SET check_in_ends_at"),
      );
      expect(update).toContain("status = 'RegistrationOpen'");
      // Extending past the tournament's own start is not an extension.
      expect(update).toContain('< t."start"');

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "TournamentCheckInOpen",
        expect.objectContaining({ steamIds: ["1"] }),
      );
    });

    it("reports the clamp when the extension would outrun the start", async () => {
      tournamentRow = tournament({
        is_organizer: true,
        status: "CheckInReview",
      });
      extended = [];

      await expect(
        controller.extendTournamentCheckIn({
          user: organizer,
          tournament_id: "tournament-1",
          minutes: 240,
        }),
      ).rejects.toThrow(/after the tournament starts/i);
    });
  });

  describe("continueTournamentCheckIn", () => {
    it("refuses a non-organizer", async () => {
      tournamentRow = tournament({ status: "CheckInReview" });

      await expect(
        controller.continueTournamentCheckIn({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/organizer/i);
    });

    it("closes registration out of review", async () => {
      tournamentRow = tournament({
        is_organizer: true,
        status: "CheckInReview",
      });

      await expect(
        controller.continueTournamentCheckIn({
          user: organizer,
          tournament_id: "tournament-1",
        }),
      ).resolves.toEqual({ success: true });

      const update = statements.find((sql) =>
        sql.includes("SET status = 'RegistrationClosed'"),
      );
      expect(update).toContain("status = 'CheckInReview'");
    });
  });

  describe("draftTournamentTeams", () => {
    it("refuses a non-organizer", async () => {
      tournamentRow = tournament({ registration_type: "free_agents" });

      await expect(
        controller.draftTournamentTeams({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/organizer/i);
    });

    it("refuses a teams-only tournament", async () => {
      tournamentRow = tournament({ is_organizer: true });

      await expect(
        controller.draftTournamentTeams({
          user: organizer,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/free agents/i);
    });

    it("refuses once the tournament is live", async () => {
      tournamentRow = tournament({
        is_organizer: true,
        registration_type: "free_agents",
        status: "Live",
      });

      await expect(
        controller.draftTournamentTeams({
          user: organizer,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/live/i);
    });

    // update_tournament_stages sizes the bracket from eligible_at, and
    // assign_seeds_to_teams is what writes it, so the seeding has to come first.
    it("drafts and rebuilds the bracket in the trigger's order", async () => {
      tournamentRow = tournament({
        is_organizer: true,
        registration_type: "both",
      });

      await expect(
        controller.draftTournamentTeams({
          user: organizer,
          tournament_id: "tournament-1",
        }),
      ).resolves.toEqual({ teams_created: 2 });

      const order = [
        "draft_tournament_free_agent_teams",
        "assign_seeds_to_teams",
        "update_tournament_stages",
        "seed_stage",
      ].map((fragment) =>
        statements.findIndex((sql) => sql.includes(fragment)),
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.every((index) => index >= 0)).toBe(true);
    });
  });

  describe("joinTournamentAsFreeAgent", () => {
    it("refuses a teams-only tournament", async () => {
      await expect(
        controller.joinTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/pre-formed teams/i);
    });

    it("refuses while registration is closed", async () => {
      tournamentRow = tournament({
        registration_type: "free_agents",
        status: "RegistrationClosed",
      });

      await expect(
        controller.joinTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/registration is not open/i);
    });

    it("refuses an invite only tournament nobody unlocked", async () => {
      tournamentRow = tournament({
        registration_type: "free_agents",
        invite_only: true,
      });

      await expect(
        controller.joinTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/invite only/i);
    });

    it("allows an unlocked player into an invite only tournament", async () => {
      tournamentRow = tournament({
        registration_type: "free_agents",
        invite_only: true,
        unlocked: true,
      });

      await expect(
        controller.joinTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).resolves.toEqual({ success: true });
    });

    it("refuses a player who fails the role or ELO gate", async () => {
      tournamentRow = tournament({ registration_type: "both" });
      eligible = false;

      await expect(
        controller.joinTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/entry requirements/i);
    });
  });

  // Signing up "with a friend" reuses the matchmaking lobby rather than
  // inventing an invite: the captain already queues this exact roster into a
  // live match, so there is nothing new to consent to.
  describe("joinTournamentAsFreeAgent with a lobby", () => {
    beforeEach(() => {
      tournamentRow = tournament({ registration_type: "free_agents" });
    });

    const join = () =>
      controller.joinTournamentAsFreeAgent({
        user: player,
        tournament_id: "tournament-1",
        with_party: true,
      });

    it("refuses when the caller is in no lobby", async () => {
      lobbyRow = undefined;

      await expect(join()).rejects.toThrow(/not in a lobby/i);
    });

    it("refuses when the caller is not the lobby captain", async () => {
      lobbyRow = { lobby_id: "lobby-1", captain: false };

      await expect(join()).rejects.toThrow(/captain of this lobby/i);
    });

    it("refuses a lobby larger than the team it would be drafted onto", async () => {
      sizingRow = { team_size: 1, carried_over: "0" };

      await expect(join()).rejects.toThrow(
        /cannot be drafted onto a team of 1/i,
      );
    });

    // Members who signed up from this lobby and then left it still hold the
    // party's id, so the cap is measured on the pool, not on the lobby.
    it("counts members who already hold the party id towards the cap", async () => {
      sizingRow = { team_size: 2, carried_over: "1" };

      await expect(join()).rejects.toThrow(/a party of 3/i);
    });

    it("names the member who fails the entry requirements", async () => {
      lobbyMembers = [
        lobbyMember({ steam_id: player.steam_id, name: "Player" }),
        lobbyMember({ name: "Friend", eligible: false }),
      ];

      await expect(join()).rejects.toThrow(/Friend does not meet/i);
    });

    it("names a member who already has a team in the tournament", async () => {
      lobbyMembers = [
        lobbyMember({ steam_id: player.steam_id, name: "Player" }),
        lobbyMember({ name: "Friend", owns_team: true }),
      ];

      await expect(join()).rejects.toThrow(/Friend already has a team/i);
    });

    // The invite gate is per player: the captain being unlocked says nothing
    // about the people they are bringing.
    it("requires every member to be unlocked on an invite only tournament", async () => {
      tournamentRow = tournament({
        registration_type: "free_agents",
        invite_only: true,
        unlocked: true,
      });
      lobbyMembers = [
        lobbyMember({ steam_id: player.steam_id, name: "Player" }),
        lobbyMember({ name: "Friend", unlocked: false }),
      ];

      await expect(join()).rejects.toThrow(/Friend has not been invited/i);
    });

    it("lets an un-unlocked member in when the tournament is open to all", async () => {
      lobbyMembers = [
        lobbyMember({ steam_id: player.steam_id, name: "Player" }),
        lobbyMember({ name: "Friend", unlocked: false }),
      ];

      await expect(join()).resolves.toEqual({ success: true });
    });

    it("refuses a member the pool has already acted on", async () => {
      lobbyMembers = [
        lobbyMember({ steam_id: player.steam_id, name: "Player" }),
        lobbyMember({ name: "Friend", pool_status: "waitlisted" }),
      ];

      await expect(join()).rejects.toThrow(/Friend is already committed/i);
    });

    it("enters the whole lobby under the lobby's id and tells the others", async () => {
      await expect(join()).resolves.toEqual({ success: true });

      const insert = statements.find((sql) =>
        sql.includes("INSERT INTO tournament_free_agents"),
      );
      expect(insert).toContain("party_id");

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "TournamentPartySignup",
        expect.objectContaining({ steamIds: [friend.steam_id] }),
      );
    });

    it("does not notify a captain signing up on their own", async () => {
      lobbyMembers = [
        lobbyMember({ steam_id: player.steam_id, name: "Player" }),
      ];

      await expect(join()).resolves.toEqual({ success: true });
      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    it("never looks at a lobby when the party was not asked for", async () => {
      await expect(
        controller.joinTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).resolves.toEqual({ success: true });

      expect(statements.some((sql) => sql.includes("lobby_players"))).toBe(
        false,
      );
    });
  });

  describe("leaveTournamentAsFreeAgent", () => {
    it("refuses once registration has closed", async () => {
      tournamentRow = tournament({ status: "RegistrationClosed" });

      await expect(
        controller.leaveTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/pool is closed/i);
    });

    it("reports when the player was never in the pool", async () => {
      removedFreeAgent = [];

      await expect(
        controller.leaveTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/not in this tournament/i);
    });

    it("removes the caller's own row", async () => {
      await expect(
        controller.leaveTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).resolves.toEqual({ success: true });
    });
  });

  describe("tournament invite codes", () => {
    it("refuses to mint a link for a tournament the caller does not run", async () => {
      tournamentRow = tournament({ is_organizer: false });

      await expect(
        controller.createTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/not the tournament organizer/i);

      expect(
        statements.some((sql) =>
          sql.includes("INSERT INTO tournament_invite_codes"),
        ),
      ).toBe(false);
    });

    it("hands back the code the database minted", async () => {
      tournamentRow = tournament({ is_organizer: true });

      await expect(
        controller.createTournamentInviteCode({
          user: organizer,
          tournament_id: "tournament-1",
          expires_in_minutes: 30,
          max_uses: 2,
        }),
      ).resolves.toEqual({ id: "code-1", code: "ABCDEFGHJK" });
    });

    // NULL is the "never expires" / "unlimited" case, so a zero or a negative
    // has to be refused rather than quietly stored as one of them.
    it("refuses a non-positive expiry or use limit", async () => {
      tournamentRow = tournament({ is_organizer: true });

      await expect(
        controller.createTournamentInviteCode({
          user: organizer,
          tournament_id: "tournament-1",
          expires_in_minutes: 0,
        }),
      ).rejects.toThrow(/expiry has to be in the future/i);

      await expect(
        controller.createTournamentInviteCode({
          user: organizer,
          tournament_id: "tournament-1",
          max_uses: 0,
        }),
      ).rejects.toThrow(/use limit has to be at least one/i);
    });

    it("refuses to revoke a link belonging to somebody else's tournament", async () => {
      tournamentRow = tournament({ is_organizer: false });

      await expect(
        controller.revokeTournamentInviteCode({
          user: player,
          invite_code_id: "code-1",
        }),
      ).rejects.toThrow(/not the tournament organizer/i);

      expect(
        statements.some((sql) => sql.includes("SET revoked_at = now()")),
      ).toBe(false);
    });

    it("stamps rather than deletes, so the uses survive the revoke", async () => {
      tournamentRow = tournament({ is_organizer: true });

      await expect(
        controller.revokeTournamentInviteCode({
          user: organizer,
          invite_code_id: "code-1",
        }),
      ).resolves.toEqual({ success: true });

      expect(
        statements.some((sql) => sql.includes("SET revoked_at = now()")),
      ).toBe(true);
      expect(
        statements.some((sql) =>
          sql.includes("DELETE FROM tournament_invite_codes\n"),
        ),
      ).toBe(false);
    });

    it("throttles a guesser before the database is even asked", async () => {
      redisExec.mockResolvedValue([
        [null, TournamentsController.REDEEM_ATTEMPTS_PER_MINUTE + 1],
      ]);

      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "NOPE",
        }),
      ).rejects.toThrow(/^invite_rate_limited$/);

      expect(statements).toHaveLength(0);
    });

    it("refuses once registration has closed", async () => {
      tournamentRow = tournament({ status: "RegistrationClosed" });

      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).rejects.toThrow(/^invite_registration_closed$/);

      expect(statements.some((sql) => sql.includes("WITH claimed AS ("))).toBe(
        false,
      );
    });

    it("claims the code, the unlock and the audit row in one statement", async () => {
      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).resolves.toEqual({ success: true });

      const [claim] = statements.filter((sql) =>
        sql.includes("WITH claimed AS ("),
      );
      expect(claim).toContain("SET uses = c.uses + 1");
      expect(claim).toContain("INSERT INTO tournament_registration_unlocks");
      expect(claim).toContain("INSERT INTO tournament_invite_code_uses");
    });

    // The claim is silent about why it matched nothing; naming the reason is a
    // second read that must never be able to let anybody in.
    it("names the refusal without ever granting on the diagnosis", async () => {
      claimedRows = [];

      diagnosisRow = {
        revoked: true,
        expired: false,
        exhausted: false,
        already_used: false,
      };
      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).rejects.toThrow(/^invite_revoked$/);

      diagnosisRow = {
        revoked: false,
        expired: true,
        exhausted: false,
        already_used: false,
      };
      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).rejects.toThrow(/^invite_expired$/);

      diagnosisRow = {
        revoked: false,
        expired: false,
        exhausted: true,
        already_used: false,
      };
      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).rejects.toThrow(/^invite_used_up$/);

      diagnosisRow = undefined;
      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).rejects.toThrow(/^invite_not_found$/);
    });

    // A double-clicked Accept is not a second entry: they already hold the
    // unlock, so it is a no-op rather than an invite_used_up refusal.
    it("treats a second redemption by the same player as a no-op", async () => {
      claimedRows = [];
      diagnosisRow = {
        revoked: false,
        expired: false,
        exhausted: true,
        already_used: true,
      };

      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).resolves.toEqual({ success: true });
    });
  });
});
