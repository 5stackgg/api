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
    matchRelayService,
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
