jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(),
  })),
  CoreV1Api: jest.fn(),
  AppsV1Api: jest.fn(),
  BatchV1Api: jest.fn(),
  Exec: jest.fn(),
  setHeaderOptions: jest.fn(),
  PatchStrategy: { StrategicMergePatch: "strategic-merge-patch" },
}));

jest.mock("src/game-server-node/game-server-node.service", () => ({
  GameServerNodeService: jest.fn(),
}));

import { SystemController } from "./system.controller";

function createController() {
  const system = {
    updateServices: jest.fn().mockResolvedValue(undefined),
    restartService: jest.fn().mockResolvedValue(undefined),
    updateDefaultOptions: jest.fn().mockResolvedValue(undefined),
  };
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
  };
  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
  };
  const gameServerNodeService = {
    updateDemoNetworkLimiters: jest.fn().mockResolvedValue(undefined),
  };
  const loggingService = {
    getServiceLogs: jest.fn().mockResolvedValue(undefined),
  };
  const chatService = {
    updateChatMessageTTL: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new SystemController(
    system as any,
    hasura as any,
    notifications as any,
    gameServerNodeService as any,
    loggingService as any,
    chatService as any,
  );

  return {
    controller,
    system,
    hasura,
    notifications,
    gameServerNodeService,
    chatService,
  };
}

function makeEventData(
  op: string,
  newData: Record<string, any>,
  oldData: Record<string, any> = {},
) {
  return { op, new: newData, old: oldData } as any;
}

describe("SystemController", () => {
  describe("updateServices", () => {
    it("delegates to system.updateServices", async () => {
      const { controller, system } = createController();

      const result = await controller.updateServices();

      expect(system.updateServices).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe("restartService", () => {
    it("delegates to system.restartService", async () => {
      const { controller, system } = createController();

      const result = await controller.restartService({ service: "api" });

      expect(system.restartService).toHaveBeenCalledWith("api");
      expect(result).toEqual({ success: true });
    });
  });

  describe("registerName", () => {
    it("updates player name and sets name_registered", async () => {
      const { controller, hasura } = createController();

      const result = await controller.registerName({
        user: { steam_id: "steam-1" } as any,
        name: "NewName",
      });

      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_players_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              pk_columns: { steam_id: "steam-1" },
              _set: { name: "NewName", name_registered: true },
            }),
          }),
        }),
      );
      expect(result).toEqual({ success: true });
    });
  });

  describe("approveNameChange", () => {
    it("updates player name by steam_id", async () => {
      const { controller, hasura } = createController();

      const result = await controller.approveNameChange({
        name: "ApprovedName",
        steam_id: "steam-2",
      });

      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          update_players_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              pk_columns: { steam_id: "steam-2" },
              _set: { name: "ApprovedName", name_registered: true },
            }),
          }),
        }),
      );
      expect(result).toEqual({ success: true });
    });
  });

  describe("requestNameChange", () => {
    it("throws when a pending name change request already exists", async () => {
      const { controller, hasura } = createController();

      hasura.query.mockResolvedValueOnce({
        notifications: [{ __typename: "notifications" }],
      });

      await expect(
        controller.requestNameChange({
          name: "NewName",
          steam_id: "steam-1",
        }),
      ).rejects.toThrow("You have already requested a name change");
    });

    it("throws when player not found", async () => {
      const { controller, hasura } = createController();

      hasura.query
        .mockResolvedValueOnce({ notifications: [] })
        .mockResolvedValueOnce({ players_by_pk: null });

      await expect(
        controller.requestNameChange({
          name: "NewName",
          steam_id: "steam-1",
        }),
      ).rejects.toThrow("Player not found");
    });

    it("sends notification with approve action when valid", async () => {
      const { controller, hasura, notifications } = createController();

      hasura.query
        .mockResolvedValueOnce({ notifications: [] })
        .mockResolvedValueOnce({
          players_by_pk: { name: "OldName" },
        });

      const result = await controller.requestNameChange({
        name: "NewName",
        steam_id: "steam-1",
      });

      expect(notifications.send).toHaveBeenCalledWith(
        "NameChangeRequest",
        expect.objectContaining({
          message: expect.stringContaining("OldName"),
          title: "Name Change Request",
          role: "administrator",
          entity_id: "steam-1",
        }),
        expect.arrayContaining([
          expect.objectContaining({
            label: "Approve",
            graphql: expect.objectContaining({
              action: "approveNameChange",
              variables: { name: "NewName", steam_id: "steam-1" },
            }),
          }),
        ]),
      );
      expect(result).toEqual({ success: true });
    });
  });

  describe("settings event", () => {
    it("updates demo network limiters when DemoNetworkLimiter changes", async () => {
      const { controller, gameServerNodeService, system } = createController();

      await controller.settings(
        makeEventData(
          "UPDATE",
          { name: "demo_network_limiter", value: "100" },
          { name: "demo_network_limiter", value: "50" },
        ),
      );

      expect(
        gameServerNodeService.updateDemoNetworkLimiters,
      ).toHaveBeenCalled();
      expect(system.updateDefaultOptions).toHaveBeenCalled();
    });

    it("does not update demo limiters when value unchanged", async () => {
      const { controller, gameServerNodeService } = createController();

      await controller.settings(
        makeEventData(
          "UPDATE",
          { name: "demo_network_limiter", value: "100" },
          { name: "demo_network_limiter", value: "100" },
        ),
      );

      expect(
        gameServerNodeService.updateDemoNetworkLimiters,
      ).not.toHaveBeenCalled();
    });

    it("updates demo limiters on INSERT", async () => {
      const { controller, gameServerNodeService } = createController();

      await controller.settings(
        makeEventData("INSERT", { name: "demo_network_limiter", value: "50" }),
      );

      expect(
        gameServerNodeService.updateDemoNetworkLimiters,
      ).toHaveBeenCalled();
    });

    it("updates chat TTL when ChatMessageTtl changes", async () => {
      const { controller, chatService } = createController();

      await controller.settings(
        makeEventData(
          "UPDATE",
          { name: "chat_message_ttl", value: "7200" },
          { name: "chat_message_ttl", value: "3600" },
        ),
      );

      expect(chatService.updateChatMessageTTL).toHaveBeenCalledWith(7200);
    });

    it("defaults chat TTL to 3600 when value is NaN", async () => {
      const { controller, chatService } = createController();

      await controller.settings(
        makeEventData(
          "UPDATE",
          { name: "chat_message_ttl", value: "not-a-number" },
          { name: "chat_message_ttl", value: "3600" },
        ),
      );

      expect(chatService.updateChatMessageTTL).toHaveBeenCalledWith(3600);
    });

    it("always calls updateDefaultOptions", async () => {
      const { controller, system } = createController();

      await controller.settings(
        makeEventData(
          "UPDATE",
          { name: "some_other_setting", value: "abc" },
          { name: "some_other_setting", value: "xyz" },
        ),
      );

      expect(system.updateDefaultOptions).toHaveBeenCalled();
    });
  });
});
