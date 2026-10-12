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
  const tournamentVoice = {
    createTournamentReadyRoom: jest.fn(),
    removeTournamentVoice: jest.fn(),
  };
  const notifications = { notifyPlayers: jest.fn() };
  const postgres = { query: jest.fn(), transaction: jest.fn() };
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
  let addedFreeAgent: Rows;
  let transactionSessions: Array<string | undefined>;
  let transactionStatements: Array<[string, Array<unknown> | undefined]>;
  let eligible: boolean;
  let mintedCode: Record<string, unknown>;
  let codeRow: Record<string, unknown> | undefined;
  let claimedRows: Rows;
  let diagnosisRow: Record<string, unknown> | undefined;
  let draftedTeams: number;
  let bracketRow: Record<string, unknown> | undefined;
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
    addedFreeAgent = [{ id: "agent-1" }];
    transactionSessions = [];
    transactionStatements = [];
    eligible = true;
    mintedCode = { id: "code-1", code: "ABCDEFGHJK" };
    codeRow = { tournament_id: "tournament-1" };
    claimedRows = [{ invite_code_id: "code-1" }];
    diagnosisRow = undefined;
    draftedTeams = 2;
    bracketRow = { tournament_id: "tournament-1" };
    statements = [];

    const route = async (sql: string) => {
      statements.push(sql);

      if (sql.includes("FOR SHARE")) {
        return [
          {
            status: tournamentRow?.status,
            check_in_required: tournamentRow?.check_in_required,
          },
        ];
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
        return addedFreeAgent;
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
      if (sql.includes("tournament_pending_check_in_recipients")) {
        return [{ steam_id: "1" }];
      }
      if (sql.includes("FROM tournament_brackets tb")) {
        return bracketRow ? [bracketRow] : [];
      }
      if (sql.includes("recreate_tournament_bracket_match")) {
        return [{ match_id: "match-2" }];
      }

      throw new Error(`unexpected query: ${sql}`);
    };

    postgres.query.mockImplementation(route);
    postgres.transaction.mockImplementation(
      async (fn: (client: unknown) => Promise<unknown>, session?: string) => {
        transactionSessions.push(session);
        return fn({
          query: async (sql: string, params?: Array<unknown>) => {
            transactionStatements.push([sql, params]);
            return { rows: await route(sql) };
          },
        });
      },
    );

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

  describe("tournament_events", () => {
    const statusChange = (from: string, to: string) =>
      controller.tournament_events({
        op: "UPDATE",
        old: { id: "tournament-1", status: from },
        new: { id: "tournament-1", status: to },
      } as never);

    const deletedMatches = () =>
      hasura.mutation.mock.calls
        .map(([mutation]) => mutation.delete_matches_by_pk?.__args.id)
        .filter(Boolean);

    beforeEach(() => {
      hasura.query.mockResolvedValue({
        tournaments_by_pk: {
          stages: [
            {
              brackets: [{ match: { id: "match-1" } }, { match: null }],
            },
          ],
        },
      });
      hasura.mutation.mockResolvedValue({});
    });

    // A round re-seeded while registration was open is drawn and parked on the
    // start. Cancelled for too few teams at that start, nothing parks it any
    // more, and CheckForScheduledMatches would open check-in for it.
    it.each([
      ["RegistrationOpen", "Cancelled"],
      ["RegistrationOpen", "CancelledMinTeams"],
      ["CheckInReview", "CancelledMinTeams"],
      ["RegistrationClosed", "CancelledMinTeams"],
    ])(
      "deletes the matches and their files going from %s to %s",
      async (from, to) => {
        await statusChange(from, to);

        expect(clips.deleteClipsForMatch).toHaveBeenCalledWith("match-1");
        expect(demoMetadata.deleteDemosForMatch).toHaveBeenCalledWith(
          "match-1",
        );
        expect(deletedMatches()).toEqual(["match-1"]);
      },
    );

    it.each([
      ["RegistrationOpen", "RegistrationClosed"],
      ["RegistrationClosed", "Live"],
      ["Live", "Finished"],
    ])("keeps the matches going from %s to %s", async (from, to) => {
      await statusChange(from, to);

      expect(clips.deleteClipsForMatch).not.toHaveBeenCalled();
      expect(demoMetadata.deleteDemosForMatch).not.toHaveBeenCalled();
      expect(deletedMatches()).toEqual([]);
    });
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
        ).rejects.toThrow(/only the team captain or a team admin/i);
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

  describe("recreateTournamentBracketMatch", () => {
    const recreated = () =>
      statements.filter((sql) =>
        sql.includes("recreate_tournament_bracket_match"),
      );

    it("refuses a bracket that does not exist", async () => {
      bracketRow = undefined;

      await expect(
        controller.recreateTournamentBracketMatch({
          user: organizer,
          tournament_bracket_id: "bracket-1",
        }),
      ).rejects.toThrow(/not found/i);
      expect(recreated()).toEqual([]);
    });

    it("refuses a non-organizer", async () => {
      await expect(
        controller.recreateTournamentBracketMatch({
          user: player,
          tournament_bracket_id: "bracket-1",
        }),
      ).rejects.toThrow(/organizer/i);
      expect(recreated()).toEqual([]);
    });

    it("recreates the slot's match for the organizer", async () => {
      tournamentRow = tournament({ is_organizer: true, status: "Live" });

      await expect(
        controller.recreateTournamentBracketMatch({
          user: organizer,
          tournament_bracket_id: "bracket-1",
        }),
      ).resolves.toEqual({ success: true });
      expect(recreated().length).toBe(1);
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

    it("moves the deadline and re-notifies everyone still pending", async () => {
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
      // Extending past the tournament's own start is not an extension.
      expect(update).toContain('< t."start"');

      expect(notifications.notifyPlayers).toHaveBeenCalledWith(
        "TournamentCheckInOpen",
        expect.objectContaining({ steamIds: ["1"] }),
      );
    });

    // An extension is for the teams that are already in. Re-opening
    // registration lets brand new ones in as well, auto-stamped as checked in
    // by tbi_tournament_team, and reseeds a bracket the organizer never agreed
    // to enlarge.
    it("leaves the tournament held rather than re-opening registration", async () => {
      tournamentRow = tournament({
        is_organizer: true,
        status: "CheckInReview",
      });

      await controller.extendTournamentCheckIn({
        user: organizer,
        tournament_id: "tournament-1",
        minutes: 15,
      });

      const update = statements.find((sql) =>
        sql.includes("SET check_in_ends_at"),
      );
      expect(update).not.toContain("status = 'RegistrationOpen'");
      expect(update).toContain("t.status = 'CheckInReview'");
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
    it("keeps a drafted player in their slot once registration has closed", async () => {
      tournamentRow = tournament({ status: "RegistrationClosed" });
      removedFreeAgent = [];

      await expect(
        controller.leaveTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).rejects.toThrow(/pool is closed/i);

      const [, params] = postgres.query.mock.calls.find(([sql]) =>
        String(sql).includes("DELETE FROM tournament_free_agents"),
      );
      expect(params[2]).toBe(false);
    });

    it("lets a waitlisted player leave after registration has closed", async () => {
      tournamentRow = tournament({ status: "RegistrationClosed" });
      removedFreeAgent = [{ id: "agent-1", status: "waitlisted" }];

      await expect(
        controller.leaveTournamentAsFreeAgent({
          user: player,
          tournament_id: "tournament-1",
        }),
      ).resolves.toEqual({ success: true });
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

  describe("organizer managing the free agent pool", () => {
    const POOL_OPEN = ["Setup", "RegistrationOpen", "CheckInReview"];
    const POOL_CLOSED = [
      "RegistrationClosed",
      "Live",
      "Paused",
      "Finished",
      "Cancelled",
      "CancelledMinTeams",
    ];

    const add = (user: User = organizer) =>
      controller.addTournamentFreeAgent({
        user,
        tournament_id: "tournament-1",
        steam_id: player.steam_id,
      });

    const remove = (user: User = organizer) =>
      controller.removeTournamentFreeAgent({
        user,
        tournament_id: "tournament-1",
        steam_id: player.steam_id,
      });

    const wrote = (fragment: string) =>
      statements.some((sql) => sql.includes(fragment));

    describe("addTournamentFreeAgent", () => {
      it("refuses a non-organizer", async () => {
        tournamentRow = tournament({ registration_type: "free_agents" });

        await expect(add(player)).rejects.toThrow(/organizer/i);
        expect(postgres.transaction).not.toHaveBeenCalled();
      });

      it.each(POOL_CLOSED)("refuses in %s", async (status) => {
        tournamentRow = tournament({
          is_organizer: true,
          registration_type: "free_agents",
          status,
        });

        await expect(add()).rejects.toThrow(/free agent pool/i);
        expect(wrote("INSERT INTO tournament_free_agents")).toBe(false);
        expect(wrote("DELETE FROM tournament_free_agents")).toBe(false);
      });

      it.each(POOL_OPEN)(
        "adds the player in %s under the organizer's own session",
        async (status) => {
          tournamentRow = tournament({
            is_organizer: true,
            registration_type: "free_agents",
            status,
          });

          await expect(add()).resolves.toEqual({ success: true });

          expect(transactionSessions).toHaveLength(1);
          expect(JSON.parse(transactionSessions[0]!)).toEqual({
            "x-hasura-role": organizer.role,
            "x-hasura-user-id": organizer.steam_id,
          });

          const lock = statements.findIndex((sql) => sql.includes("FOR SHARE"));
          const insert = statements.findIndex((sql) =>
            sql.includes("INSERT INTO tournament_free_agents"),
          );
          expect(lock).toBeGreaterThanOrEqual(0);
          expect(insert).toBeGreaterThan(lock);
        },
      );

      it.each([true, false])(
        "stamps the player checked in only where check-in is required (%s)",
        async (checkInRequired) => {
          tournamentRow = tournament({
            is_organizer: true,
            registration_type: "free_agents",
            status: "CheckInReview",
            check_in_required: checkInRequired,
          });

          await add();

          const [sql, params] = transactionStatements.find(([statement]) =>
            statement.includes("INSERT INTO tournament_free_agents"),
          )!;
          expect(sql).toContain("checked_in_at");
          expect(params).toEqual([
            "tournament-1",
            player.steam_id,
            checkInRequired,
          ]);
        },
      );

      it("reports a player who is already in the pool", async () => {
        tournamentRow = tournament({
          is_organizer: true,
          registration_type: "free_agents",
        });
        addedFreeAgent = [];

        await expect(add()).rejects.toThrow(/already in/i);
      });
    });

    describe("removeTournamentFreeAgent", () => {
      it("refuses a non-organizer", async () => {
        tournamentRow = tournament({ registration_type: "free_agents" });

        await expect(remove(player)).rejects.toThrow(/organizer/i);
        expect(postgres.transaction).not.toHaveBeenCalled();
      });

      it.each(POOL_CLOSED)("refuses in %s", async (status) => {
        tournamentRow = tournament({
          is_organizer: true,
          registration_type: "free_agents",
          status,
        });

        await expect(remove()).rejects.toThrow(/free agent pool/i);
        expect(wrote("DELETE FROM tournament_free_agents")).toBe(false);
      });

      it.each(POOL_OPEN)("removes a waiting player in %s", async (status) => {
        tournamentRow = tournament({
          is_organizer: true,
          registration_type: "free_agents",
          status,
        });

        await expect(remove()).resolves.toEqual({ success: true });

        const removal = statements.find((sql) =>
          sql.includes("DELETE FROM tournament_free_agents"),
        );
        expect(removal).toContain("status IN ('registered', 'waitlisted')");
      });

      it("refuses a drafted player, who is not waiting in the pool", async () => {
        tournamentRow = tournament({
          is_organizer: true,
          registration_type: "free_agents",
        });
        removedFreeAgent = [];

        await expect(remove()).rejects.toThrow(/registered or waitlisted/i);
      });
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

    // A double-clicked Accept is not a second entry: they already spent the
    // link, so it is a no-op rather than an invite_used_up refusal.
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

    // "Accepted" has to mean they can actually register. The use row and the
    // unlock can come apart -- an organizer may delete an unlock -- and without
    // this the spent link answers success forever while registration keeps
    // refusing them.
    it("re-grants the unlock on a link that was already spent", async () => {
      claimedRows = [];
      diagnosisRow = {
        revoked: false,
        expired: false,
        exhausted: false,
        already_used: true,
      };

      await controller.redeemTournamentInviteCode({
        user: player,
        tournament_id: "tournament-1",
        code: "ABCDEFGHJK",
      });

      const regrant = statements.find(
        (sql) =>
          sql.includes("INSERT INTO tournament_registration_unlocks") &&
          !sql.includes("WITH claimed AS ("),
      );
      expect(regrant).toContain("ON CONFLICT DO NOTHING");
    });

    // A limiter that reads zero whenever Redis breaks is a limiter that turns
    // itself off exactly when it matters.
    it("refuses rather than fails open when redis cannot count", async () => {
      redisExec.mockResolvedValue(null);

      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).rejects.toThrow(/^invite_rate_limited$/);

      redisExec.mockResolvedValue([[new Error("READONLY"), null]]);

      await expect(
        controller.redeemTournamentInviteCode({
          user: player,
          tournament_id: "tournament-1",
          code: "ABCDEFGHJK",
        }),
      ).rejects.toThrow(/^invite_rate_limited$/);
    });
  });
});
