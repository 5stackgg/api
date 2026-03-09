jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import { MarkPlayerOffline } from "./MarkPlayerOffline";

function createProcessor() {
  const hasura = {
    mutation: jest.fn().mockResolvedValue({}),
  };
  const matchmakingLobbyService = {
    getPlayerLobby: jest.fn().mockResolvedValue(null),
    removeLobbyFromQueue: jest.fn().mockResolvedValue(undefined),
    removeLobbyDetails: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new MarkPlayerOffline(
    hasura as any,
    matchmakingLobbyService as any,
  );

  return { processor, hasura, matchmakingLobbyService };
}

describe("MarkPlayerOffline", () => {
  it("deletes lobby_players with Accepted status for the steamId", async () => {
    const { processor, hasura } = createProcessor();

    await processor.process({
      data: { steamId: "76561198000000001" },
    } as any);

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_lobby_players: expect.objectContaining({
          __args: expect.objectContaining({
            where: expect.objectContaining({
              steam_id: { _eq: "76561198000000001" },
              status: { _eq: "Accepted" },
            }),
          }),
        }),
      }),
    );
  });

  it("removes lobby from queue and details when player has a lobby", async () => {
    const { processor, matchmakingLobbyService } = createProcessor();

    matchmakingLobbyService.getPlayerLobby.mockResolvedValueOnce({
      id: "lobby-1",
    });

    await processor.process({
      data: { steamId: "76561198000000001" },
    } as any);

    expect(matchmakingLobbyService.removeLobbyFromQueue).toHaveBeenCalledWith(
      "lobby-1",
    );
    expect(matchmakingLobbyService.removeLobbyDetails).toHaveBeenCalledWith(
      "lobby-1",
    );
  });

  it("does not call removeLobbyFromQueue when player has no lobby", async () => {
    const { processor, matchmakingLobbyService } = createProcessor();

    matchmakingLobbyService.getPlayerLobby.mockResolvedValueOnce(null);

    await processor.process({
      data: { steamId: "76561198000000001" },
    } as any);

    expect(
      matchmakingLobbyService.removeLobbyFromQueue,
    ).not.toHaveBeenCalled();
    expect(matchmakingLobbyService.removeLobbyDetails).not.toHaveBeenCalled();
  });
});
