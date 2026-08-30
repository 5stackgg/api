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
  let passcodeRow: Record<string, unknown> | undefined;
  let draftedTeams: number;
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
    passcodeRow = undefined;
    draftedTeams = 2;
    statements = [];

    postgres.query.mockImplementation(async (sql: string) => {
      statements.push(sql);

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
      if (sql.includes("registration_passcode")) {
        return passcodeRow ? [passcodeRow] : [];
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

  describe("unlockTournamentRegistration", () => {
    // "No passcode set" and "wrong passcode" must not be told apart: the
    // distinction is half the search space handed to a guesser for free.
    it("refuses a tournament with no passcode indistinguishably", async () => {
      passcodeRow = {
        status: "RegistrationOpen",
        has_passcode: false,
        matches: false,
      };

      await expect(
        controller.unlockTournamentRegistration({
          user: player,
          tournament_id: "tournament-1",
          passcode: "hunter2",
        }),
      ).rejects.toThrow(/^incorrect passcode$/i);
    });

    it("throttles a guesser before the database is even asked", async () => {
      passcodeRow = {
        status: "RegistrationOpen",
        has_passcode: true,
        matches: false,
      };
      redisExec.mockResolvedValue([
        [null, TournamentsController.PASSCODE_ATTEMPTS_PER_MINUTE + 1],
      ]);

      await expect(
        controller.unlockTournamentRegistration({
          user: player,
          tournament_id: "tournament-1",
          passcode: "nope",
        }),
      ).rejects.toThrow(/too many passcode attempts/i);

      expect(statements).toHaveLength(0);
    });

    it("refuses a wrong passcode", async () => {
      passcodeRow = {
        status: "RegistrationOpen",
        has_passcode: true,
        matches: false,
      };

      await expect(
        controller.unlockTournamentRegistration({
          user: player,
          tournament_id: "tournament-1",
          passcode: "nope",
        }),
      ).rejects.toThrow(/^incorrect passcode$/i);
    });

    it("records the unlock on a match", async () => {
      passcodeRow = {
        status: "RegistrationOpen",
        has_passcode: true,
        matches: true,
      };

      await expect(
        controller.unlockTournamentRegistration({
          user: player,
          tournament_id: "tournament-1",
          passcode: "hunter2",
        }),
      ).resolves.toEqual({ success: true });

      expect(
        statements.some((sql) =>
          sql.includes("INSERT INTO tournament_registration_unlocks"),
        ),
      ).toBe(true);
    });
  });
});
