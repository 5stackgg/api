jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { MatchesController } from "./matches.controller";

function createController() {
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
  };
  const postgres = { query: jest.fn() };
  const config = {
    get: jest.fn().mockReturnValue({ webDomain: "https://5stack.test" }),
  };
  const matchmaking = { cancelMatchMakingByMatchId: jest.fn() };
  const matchAssistant = {
    assignServer: jest.fn(),
    reserveDedicatedServer: jest.fn(),
    stopOnDemandServer: jest.fn(),
    sendServerMatchId: jest.fn(),
    canSchedule: jest.fn().mockResolvedValue(true),
    canStart: jest.fn().mockResolvedValue(true),
    canCancel: jest.fn().mockResolvedValue(true),
    isOrganizer: jest.fn().mockResolvedValue(true),
    updateMatchStatus: jest.fn().mockResolvedValue(undefined),
  };
  const discordBotMessaging = { removeMatchChannel: jest.fn() };
  const discordMatchOverview = { updateMatchOverview: jest.fn() };
  const discordBotVoiceChannels = { removeTeamChannels: jest.fn() };
  const notifications = { sendMatchStatusNotification: jest.fn() };
  const chatService = { removeLobby: jest.fn() };
  const eloQueue = { add: jest.fn() };
  const scheduledQueue = { add: jest.fn() };
  const s3 = { remove: jest.fn() };
  const matchRelayService = { removeBroadcast: jest.fn() };
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
    verbose: jest.fn(),
  } as unknown as Logger;

  const controller = new MatchesController(
    logger,
    hasura as any,
    postgres as any,
    config as any,
    matchmaking as any,
    matchAssistant as any,
    discordBotMessaging as any,
    discordMatchOverview as any,
    discordBotVoiceChannels as any,
    notifications as any,
    chatService as any,
    eloQueue as any,
    scheduledQueue as any,
    s3 as any,
    matchRelayService as any,
  );

  return {
    controller,
    hasura,
    matchAssistant,
    notifications,
    chatService,
    eloQueue,
    scheduledQueue,
    matchmaking,
    discordBotMessaging,
    discordBotVoiceChannels,
    discordMatchOverview,
    matchRelayService,
    s3,
    logger,
  };
}

function makeEventData(
  op: string,
  newData: Record<string, any>,
  oldData: Record<string, any> = {},
) {
  return { op, new: newData, old: oldData } as any;
}

describe("MatchesController - match_events", () => {
  describe("status change notification", () => {
    it("sends notification when status changes", async () => {
      const { controller, notifications, hasura } = createController();
      hasura.query.mockResolvedValue({
        matches_by_pk: {
          id: "m1",
          options: { prefer_dedicated_server: false },
          server: null,
        },
      });

      await controller.match_events(
        makeEventData("UPDATE", { id: "m1", status: "Live" }, { id: "m1", status: "Scheduled" }),
      );

      expect(notifications.sendMatchStatusNotification).toHaveBeenCalledWith(
        "m1",
        "Live",
        "Scheduled",
      );
    });

    it("does not notify when status unchanged", async () => {
      const { controller, notifications, hasura } = createController();
      hasura.query.mockResolvedValue({
        matches_by_pk: {
          id: "m1",
          options: { prefer_dedicated_server: false },
          server: null,
        },
      });

      await controller.match_events(
        makeEventData("UPDATE", { id: "m1", status: "Live" }, { id: "m1", status: "Live" }),
      );

      expect(notifications.sendMatchStatusNotification).not.toHaveBeenCalled();
    });
  });

  describe("terminal status handling", () => {
    const terminalStatuses = ["Finished", "Canceled", "Forfeit", "Tie", "Surrendered"];

    for (const status of terminalStatuses) {
      it(`queues ELO calculation on ${status}`, async () => {
        const { controller, eloQueue, hasura } = createController();

        hasura.query
          .mockResolvedValueOnce({ servers_by_pk: { is_dedicated: true } })
          .mockResolvedValueOnce({ match_options_by_pk: { tv_delay: 0 } });

        await controller.match_events(
          makeEventData(
            "UPDATE",
            { id: "m1", status, server_id: "s1", match_options_id: "opts1" },
            { id: "m1", status: "Live" },
          ),
        );

        expect(eloQueue.add).toHaveBeenCalledWith("EloCalculation", { matchId: "m1" });
      });
    }

    it("cancels matchmaking on terminal status", async () => {
      const { controller, matchmaking, hasura } = createController();

      hasura.query
        .mockResolvedValueOnce({ servers_by_pk: { is_dedicated: true } })
        .mockResolvedValueOnce({ match_options_by_pk: { tv_delay: 0 } });

      await controller.match_events(
        makeEventData(
          "UPDATE",
          { id: "m1", status: "Canceled", server_id: "s1", match_options_id: "opts1" },
          { id: "m1", status: "Live" },
        ),
      );

      expect(matchmaking.cancelMatchMakingByMatchId).toHaveBeenCalledWith("m1");
    });

    it("schedules on-demand server stop for non-dedicated servers", async () => {
      const { controller, scheduledQueue, hasura } = createController();

      hasura.query
        .mockResolvedValueOnce({ servers_by_pk: { is_dedicated: false } })
        .mockResolvedValueOnce({ match_options_by_pk: { tv_delay: 30 } });

      await controller.match_events(
        makeEventData(
          "UPDATE",
          { id: "m1", status: "Finished", server_id: "s1", match_options_id: "opts1" },
          { id: "m1", status: "Live" },
        ),
      );

      expect(scheduledQueue.add).toHaveBeenCalledWith(
        "StopOnDemandServer",
        { matchId: "m1" },
        { delay: 30000 },
      );
    });

    it("does not schedule stop for dedicated servers", async () => {
      const { controller, scheduledQueue, hasura } = createController();

      hasura.query
        .mockResolvedValueOnce({ servers_by_pk: { is_dedicated: true } })
        .mockResolvedValueOnce({ match_options_by_pk: { tv_delay: 0 } });

      await controller.match_events(
        makeEventData(
          "UPDATE",
          { id: "m1", status: "Finished", server_id: "s1", match_options_id: "opts1" },
          { id: "m1", status: "Live" },
        ),
      );

      expect(scheduledQueue.add).not.toHaveBeenCalled();
    });

    it("uses 0 delay for Canceled status", async () => {
      const { controller, scheduledQueue, hasura } = createController();

      hasura.query
        .mockResolvedValueOnce({ servers_by_pk: { is_dedicated: false } })
        .mockResolvedValueOnce({ match_options_by_pk: { tv_delay: 30 } });

      await controller.match_events(
        makeEventData(
          "UPDATE",
          { id: "m1", status: "Canceled", server_id: "s1", match_options_id: "opts1" },
          { id: "m1", status: "Live" },
        ),
      );

      // Canceled overrides TV delay to 0
      expect(scheduledQueue.add).toHaveBeenCalledWith(
        "StopOnDemandServer",
        { matchId: "m1" },
        undefined,
      );
    });
  });

  describe("DELETE event", () => {
    it("removes chat lobby on DELETE", async () => {
      const { controller, chatService, hasura } = createController();

      hasura.query
        .mockResolvedValueOnce({ servers_by_pk: { is_dedicated: true } })
        .mockResolvedValueOnce({ match_options_by_pk: { tv_delay: 0 } });

      await controller.match_events(
        makeEventData("DELETE", { id: "m1", server_id: null, match_options_id: "opts1" }, { id: "m1" }),
      );

      expect(chatService.removeLobby).toHaveBeenCalledWith("match", "m1");
    });
  });

  describe("server removal mid-match", () => {
    it("stops on-demand server when server_id changes", async () => {
      const { controller, matchAssistant, hasura } = createController();

      hasura.query.mockResolvedValue({
        matches_by_pk: {
          id: "m1",
          options: { prefer_dedicated_server: false },
          server: null,
        },
      });

      await controller.match_events(
        makeEventData(
          "UPDATE",
          { id: "m1", status: "Live", server_id: "new-server" },
          { id: "m1", status: "Live", server_id: "old-server" },
        ),
      );

      expect(matchAssistant.stopOnDemandServer).toHaveBeenCalledWith("m1");
    });
  });

  describe("server assignment on Live", () => {
    it("assigns server when transitioning to Live without server", async () => {
      const { controller, matchAssistant, hasura } = createController();

      hasura.query.mockResolvedValue({
        matches_by_pk: {
          id: "m1",
          options: { prefer_dedicated_server: false },
          server: null,
        },
      });

      await controller.match_events(
        makeEventData(
          "UPDATE",
          { id: "m1", status: "Live", server_id: null },
          { id: "m1", status: "Scheduled" },
        ),
      );

      expect(matchAssistant.assignServer).toHaveBeenCalledWith("m1");
    });
  });
});

describe("MatchesController - scheduleMatch", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws when user cannot schedule", async () => {
    const { controller, matchAssistant } = createController();
    matchAssistant.canSchedule.mockResolvedValueOnce(false);

    await expect(
      controller.scheduleMatch({ user, match_id: "m1" }),
    ).rejects.toThrow("cannot schedule match");
  });

  it("throws when time is in the past", async () => {
    const { controller } = createController();
    const pastDate = new Date("2020-01-01");

    await expect(
      controller.scheduleMatch({ user, match_id: "m1", time: pastDate }),
    ).rejects.toThrow("date must be in the future");
  });

  it("sets status to Scheduled when time provided", async () => {
    const { controller, hasura } = createController();
    const futureDate = new Date(Date.now() + 86400000);

    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: { id: "m1", status: "Scheduled" },
    });

    const result = await controller.scheduleMatch({
      user,
      match_id: "m1",
      time: futureDate,
    });

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({
              status: "Scheduled",
              scheduled_at: futureDate,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("sets status to WaitingForCheckIn when no time", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: { id: "m1", status: "WaitingForCheckIn" },
    });

    const result = await controller.scheduleMatch({ user, match_id: "m1" });

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({
              status: "WaitingForCheckIn",
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("throws when mutation returns wrong status", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: { id: "m1", status: "Live" },
    });

    await expect(
      controller.scheduleMatch({ user, match_id: "m1" }),
    ).rejects.toThrow("Unable to schedule match");
  });
});

describe("MatchesController - startMatch", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws when user cannot start", async () => {
    const { controller, matchAssistant } = createController();
    matchAssistant.canStart.mockResolvedValueOnce(false);

    await expect(
      controller.startMatch({ user, match_id: "m1", server_id: "s1" }),
    ).rejects.toThrow("you are not a match organizer");
  });

  it("sets match to Live with server_id", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: {
        id: "m1",
        status: "Live",
        current_match_map_id: "map1",
        server: { game_server_node_id: "node1" },
      },
    });

    const result = await controller.startMatch({
      user,
      match_id: "m1",
      server_id: "s1",
    });

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({
              status: "Live",
              server_id: "s1",
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("returns success on Veto status", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: {
        id: "m1",
        status: "Veto",
        current_match_map_id: null,
        server: null,
      },
    });

    const result = await controller.startMatch({
      user,
      match_id: "m1",
      server_id: "s1",
    });

    expect(result).toEqual({ success: true });
  });

  it("throws when status is not Live or Veto", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: { id: "m1", status: "WaitingForServer" },
    });

    await expect(
      controller.startMatch({ user, match_id: "m1", server_id: "s1" }),
    ).rejects.toThrow("Server is not available");
  });

  it("throws when update returns null", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: null,
    });

    await expect(
      controller.startMatch({ user, match_id: "m1", server_id: "s1" }),
    ).rejects.toThrow("unable to update match");
  });
});

describe("MatchesController - cancelMatch", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws when user cannot cancel", async () => {
    const { controller, matchAssistant } = createController();
    matchAssistant.canCancel.mockResolvedValueOnce(false);

    await expect(
      controller.cancelMatch({ user, match_id: "m1" }),
    ).rejects.toThrow("you are not a match organizer");
  });

  it("calls updateMatchStatus with Canceled", async () => {
    const { controller, matchAssistant } = createController();

    const result = await controller.cancelMatch({ user, match_id: "m1" });

    expect(matchAssistant.updateMatchStatus).toHaveBeenCalledWith(
      "m1",
      "Canceled",
    );
    expect(result).toEqual({ success: true });
  });
});

describe("MatchesController - forfeitMatch", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws when not organizer", async () => {
    const { controller, matchAssistant } = createController();
    matchAssistant.isOrganizer.mockResolvedValueOnce(false);

    await expect(
      controller.forfeitMatch({
        user,
        match_id: "m1",
        winning_lineup_id: "l1",
      }),
    ).rejects.toThrow("you are not a match organizer");
  });

  it("throws when match not found", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({ matches_by_pk: null });

    await expect(
      controller.forfeitMatch({
        user,
        match_id: "m1",
        winning_lineup_id: "l1",
      }),
    ).rejects.toThrow("match not found");
  });

  it("throws when match already in terminal status", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: { status: "Finished" },
    });

    await expect(
      controller.forfeitMatch({
        user,
        match_id: "m1",
        winning_lineup_id: "l1",
      }),
    ).rejects.toThrow("cannot forfeit a match that has already ended");
  });

  it("sets winning_lineup_id and status Forfeit", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: { status: "Live" },
    });
    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: { id: "m1", status: "Forfeit" },
    });

    const result = await controller.forfeitMatch({
      user,
      match_id: "m1",
      winning_lineup_id: "l1",
    });

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({
              winning_lineup_id: "l1",
              status: "Forfeit",
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("throws when mutation result is not Forfeit", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: { status: "Live" },
    });
    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: { id: "m1", status: "Live" },
    });

    await expect(
      controller.forfeitMatch({
        user,
        match_id: "m1",
        winning_lineup_id: "l1",
      }),
    ).rejects.toThrow("Unable to cancel match");
  });
});

describe("MatchesController - setMatchWinner", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws when not organizer", async () => {
    const { controller, matchAssistant } = createController();
    matchAssistant.isOrganizer.mockResolvedValueOnce(false);

    await expect(
      controller.setMatchWinner({
        user,
        match_id: "m1",
        winning_lineup_id: "l1",
      }),
    ).rejects.toThrow("you are not a match organizer");
  });

  it("sets winning_lineup_id via mutation", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      update_matches_by_pk: { id: "m1", status: "Finished" },
    });

    const result = await controller.setMatchWinner({
      user,
      match_id: "m1",
      winning_lineup_id: "l1",
    });

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { winning_lineup_id: "l1" },
          }),
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });
});

describe("MatchesController - joinLineup", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws for Private lobby", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        options: { lobby_access: "Private", invite_code: null },
      },
    });

    await expect(
      controller.joinLineup({
        user,
        match_id: "m1",
        lineup_id: "l1",
        code: "",
      }),
    ).rejects.toThrow("Cannot Join a Private Lobby");
  });

  it("throws for Invite lobby with wrong code", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        options: { lobby_access: "Invite", invite_code: "secret" },
      },
    });

    await expect(
      controller.joinLineup({
        user,
        match_id: "m1",
        lineup_id: "l1",
        code: "wrong",
      }),
    ).rejects.toThrow("Invalid Code for Match");
  });

  it("allows join with correct invite code", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        options: { lobby_access: "Invite", invite_code: "secret" },
      },
    });
    hasura.mutation.mockResolvedValueOnce({
      insert_match_lineup_players_one: { id: "player-1" },
    });

    const result = await controller.joinLineup({
      user,
      match_id: "m1",
      lineup_id: "l1",
      code: "secret",
    });

    expect(result).toEqual({ success: true });
  });

  it("allows join for Open lobby", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        options: { lobby_access: "Open", invite_code: null },
      },
    });
    hasura.mutation.mockResolvedValueOnce({
      insert_match_lineup_players_one: { id: "player-1" },
    });

    const result = await controller.joinLineup({
      user,
      match_id: "m1",
      lineup_id: "l1",
      code: "",
    });

    expect(result).toEqual({ success: true });
  });
});

describe("MatchesController - leaveLineup", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("returns success when player removed", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      delete_match_lineup_players: { returning: [{ id: "p1" }] },
    });

    const result = await controller.leaveLineup({ user, match_id: "m1" });

    expect(result).toEqual({ success: true });
  });

  it("returns false when no player found", async () => {
    const { controller, hasura } = createController();

    hasura.mutation.mockResolvedValueOnce({
      delete_match_lineup_players: { returning: [] },
    });

    const result = await controller.leaveLineup({ user, match_id: "m1" });

    expect(result).toEqual({ success: false });
  });
});

describe("MatchesController - switchLineup", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws for Private lobby", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        id: "m1",
        options: { lobby_access: "Private" },
        max_players_per_lineup: 5,
        lineup_1: {
          id: "l1",
          is_on_lineup: true,
          lineup_players: [{ steam_id: "s1" }],
        },
        lineup_2: {
          id: "l2",
          is_on_lineup: false,
          lineup_players: [],
        },
      },
    });

    await expect(
      controller.switchLineup({ user, match_id: "m1" }),
    ).rejects.toThrow("cannot switch when match is set to private");
  });

  it("throws when not on any lineup", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        id: "m1",
        options: { lobby_access: "Open" },
        max_players_per_lineup: 5,
        lineup_1: { id: "l1", is_on_lineup: false, lineup_players: [] },
        lineup_2: { id: "l2", is_on_lineup: false, lineup_players: [] },
      },
    });

    await expect(
      controller.switchLineup({ user, match_id: "m1" }),
    ).rejects.toThrow("not able to switch a lineup which you are not on");
  });

  it("throws when target lineup is full (switching from lineup_1)", async () => {
    const { controller, hasura } = createController();

    const fullPlayers = Array.from({ length: 5 }, (_, i) => ({
      steam_id: `s${i}`,
    }));
    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        id: "m1",
        options: { lobby_access: "Open" },
        max_players_per_lineup: 5,
        lineup_1: {
          id: "l1",
          is_on_lineup: true,
          lineup_players: [{ steam_id: "me" }],
        },
        lineup_2: {
          id: "l2",
          is_on_lineup: false,
          lineup_players: fullPlayers,
        },
      },
    });

    await expect(
      controller.switchLineup({ user, match_id: "m1" }),
    ).rejects.toThrow("unable to swithch");
  });

  it("switches from lineup_1 to lineup_2", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: {
        id: "m1",
        options: { lobby_access: "Open" },
        max_players_per_lineup: 5,
        lineup_1: {
          id: "l1",
          is_on_lineup: true,
          lineup_players: [{ steam_id: "me" }],
        },
        lineup_2: {
          id: "l2",
          is_on_lineup: false,
          lineup_players: [{ steam_id: "other" }],
        },
      },
    });
    hasura.mutation.mockResolvedValueOnce({
      update_match_lineup_players: { affected_rows: 1 },
    });

    const result = await controller.switchLineup({ user, match_id: "m1" });

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_match_lineup_players: expect.objectContaining({
          __args: expect.objectContaining({
            where: expect.objectContaining({
              match_lineup_id: { _eq: "l1" },
            }),
            _set: { match_lineup_id: "l2" },
          }),
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });
});

describe("MatchesController - deleteMatch", () => {
  it("throws when match is Live", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: { id: "m1", status: "Live" },
    });

    await expect(
      controller.deleteMatch({ match_id: "m1" }),
    ).rejects.toThrow("cannot delete a live match");
  });

  it("removes demo files from S3 and deletes match", async () => {
    const { controller, hasura, s3 } = createController();

    hasura.query
      .mockResolvedValueOnce({
        matches_by_pk: { id: "m1", status: "Canceled" },
      })
      .mockResolvedValueOnce({
        match_map_demos: [
          { id: "d1", file: "demos/match1.dem" },
        ],
      });

    const result = await controller.deleteMatch({ match_id: "m1" });

    expect(s3.remove).toHaveBeenCalledWith("demos/match1.dem");
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_match_map_demos_by_pk: expect.objectContaining({
          __args: { id: "d1" },
        }),
      }),
    );
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_matches_by_pk: expect.objectContaining({
          __args: { id: "m1" },
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("handles match_options deletion error gracefully", async () => {
    const { controller, hasura, logger } = createController();

    hasura.query
      .mockResolvedValueOnce({
        matches_by_pk: { id: "m1", status: "Canceled" },
      })
      .mockResolvedValueOnce({ match_map_demos: [] });

    // First mutation: delete_matches_by_pk succeeds
    hasura.mutation
      .mockResolvedValueOnce({})
      // Second mutation: delete_match_options_by_pk fails
      .mockRejectedValueOnce(new Error("FK constraint"));

    const result = await controller.deleteMatch({ match_id: "m1" });

    expect(logger.error).toHaveBeenCalledWith(
      "[m1] match options being used by other matches",
      expect.any(Error),
    );
    expect(result).toEqual({ success: true });
  });
});

describe("MatchesController - checkIntoMatch", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws when match not WaitingForCheckIn", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: { status: "Scheduled" },
    });

    await expect(
      controller.checkIntoMatch({ user, match_id: "m1" }),
    ).rejects.toThrow("match is not accepting check in's at this time");
  });

  it("marks player as checked_in", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: { status: "WaitingForCheckIn" },
    });

    await controller.checkIntoMatch({ user, match_id: "m1" });

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_match_lineup_players: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { checked_in: true },
          }),
        }),
      }),
    );
  });

  it("transitions match to Live when both lineups ready", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches_by_pk: { status: "WaitingForCheckIn" },
    });

    await controller.checkIntoMatch({ user, match_id: "m1" });

    // Second mutation attempts to transition to Live
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { status: "Live" },
            where: expect.objectContaining({
              _and: expect.arrayContaining([
                expect.objectContaining({ id: { _eq: "m1" } }),
              ]),
            }),
          }),
        }),
      }),
    );
  });
});

describe("MatchesController - server_availability", () => {
  it("returns early when server disabled", async () => {
    const { controller, matchAssistant } = createController();

    await controller.server_availability(
      makeEventData("UPDATE", { enabled: false, connected: true, reserved_by_match_id: null }),
    );

    expect(matchAssistant.assignServer).not.toHaveBeenCalled();
  });

  it("returns early when server disconnected", async () => {
    const { controller, matchAssistant } = createController();

    await controller.server_availability(
      makeEventData("UPDATE", { enabled: true, connected: false, reserved_by_match_id: null }),
    );

    expect(matchAssistant.assignServer).not.toHaveBeenCalled();
  });

  it("returns early when server reserved", async () => {
    const { controller, matchAssistant } = createController();

    await controller.server_availability(
      makeEventData("UPDATE", { enabled: true, connected: true, reserved_by_match_id: "m1" }),
    );

    expect(matchAssistant.assignServer).not.toHaveBeenCalled();
  });

  it("assigns server to oldest WaitingForServer match", async () => {
    const { controller, matchAssistant, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      matches: [{ id: "m1" }],
    });

    await controller.server_availability(
      makeEventData("UPDATE", {
        enabled: true,
        connected: true,
        reserved_by_match_id: null,
        region: "eu-west",
      }),
    );

    expect(matchAssistant.assignServer).toHaveBeenCalledWith("m1");
  });

  it("does nothing when no matches waiting", async () => {
    const { controller, matchAssistant, hasura } = createController();

    hasura.query.mockResolvedValueOnce({ matches: [] });

    await controller.server_availability(
      makeEventData("UPDATE", {
        enabled: true,
        connected: true,
        reserved_by_match_id: null,
        region: "eu-west",
      }),
    );

    expect(matchAssistant.assignServer).not.toHaveBeenCalled();
  });
});

describe("MatchesController - node_server_availability", () => {
  it("returns early when node disabled", async () => {
    const { controller, hasura } = createController();

    await controller.node_server_availability(
      makeEventData("UPDATE", { id: "n1", enabled: false, status: "Online" }),
    );

    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("returns early when node not Online", async () => {
    const { controller, hasura } = createController();

    await controller.node_server_availability(
      makeEventData("UPDATE", { id: "n1", enabled: true, status: "Offline" }),
    );

    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("assigns servers to multiple waiting matches", async () => {
    const { controller, matchAssistant, hasura } = createController();

    hasura.query
      .mockResolvedValueOnce({
        game_server_nodes_by_pk: {
          servers_aggregate: { aggregate: { count: 2 } },
        },
      })
      .mockResolvedValueOnce({
        matches: [{ id: "m1" }, { id: "m2" }],
      });

    await controller.node_server_availability(
      makeEventData("UPDATE", {
        id: "n1",
        enabled: true,
        status: "Online",
        region: "eu-west",
      }),
    );

    expect(matchAssistant.assignServer).toHaveBeenCalledWith("m1");
    expect(matchAssistant.assignServer).toHaveBeenCalledWith("m2");
  });

  it("handles no waiting matches", async () => {
    const { controller, matchAssistant, hasura } = createController();

    hasura.query
      .mockResolvedValueOnce({
        game_server_nodes_by_pk: {
          servers_aggregate: { aggregate: { count: 3 } },
        },
      })
      .mockResolvedValueOnce({ matches: [] });

    await controller.node_server_availability(
      makeEventData("UPDATE", {
        id: "n1",
        enabled: true,
        status: "Online",
        region: "eu-west",
      }),
    );

    expect(matchAssistant.assignServer).not.toHaveBeenCalled();
  });
});

describe("MatchesController - match_veto_pick", () => {
  it("calls updateMatchOverview with correct matchId", async () => {
    const { controller, discordMatchOverview } = createController();

    await controller.match_veto_pick(
      makeEventData("INSERT", { match_id: "m1" }),
    );

    expect(discordMatchOverview.updateMatchOverview).toHaveBeenCalledWith("m1");
  });
});

describe("MatchesController - match_lineup_players", () => {
  it("sends server match id when match is Live", async () => {
    const { controller, hasura, matchAssistant } = createController();

    hasura.query.mockResolvedValueOnce({
      matches: [{ id: "m1", status: "Live" }],
    });

    await controller.match_lineup_players(
      makeEventData("INSERT", { match_lineup_id: "ml1" }),
    );

    expect(matchAssistant.sendServerMatchId).toHaveBeenCalledWith("m1");
  });

  it("does nothing when match is not Live", async () => {
    const { controller, hasura, matchAssistant } = createController();

    hasura.query.mockResolvedValueOnce({
      matches: [{ id: "m1", status: "Scheduled" }],
    });

    await controller.match_lineup_players(
      makeEventData("INSERT", { match_lineup_id: "ml1" }),
    );

    expect(matchAssistant.sendServerMatchId).not.toHaveBeenCalled();
  });

  it("does nothing when match not found", async () => {
    const { controller, hasura, matchAssistant } = createController();

    hasura.query.mockResolvedValueOnce({ matches: [] });

    await controller.match_lineup_players(
      makeEventData("INSERT", { match_lineup_id: "ml1" }),
    );

    expect(matchAssistant.sendServerMatchId).not.toHaveBeenCalled();
  });
});
