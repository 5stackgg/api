jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { MatchAssistantService } from "./match-assistant.service";

describe("MatchAssistantService", () => {
  let service: MatchAssistantService;
  let hasura: {
    query: jest.Mock;
    mutation: jest.Mock;
  };

  beforeEach(() => {
    hasura = {
      query: jest.fn(),
      mutation: jest.fn(),
    };

    service = new MatchAssistantService(
      {
        warn: jest.fn(),
        log: jest.fn(),
        error: jest.fn(),
        verbose: jest.fn(),
      } as any,
      {} as any,
      {
        lock: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
      } as any,
      {
        get: jest.fn((key: string) => {
          if (key === "gameServers") {
            return {
              namespace: "test",
            };
          }

          return {};
        }),
      } as any,
      hasura as any,
      {} as any,
      {
        add: jest.fn(),
      } as any,
    );
  });

  it("reboots an assigned on-demand server in an allowed status", async () => {
    hasura.query.mockResolvedValue({
      matches_by_pk: {
        id: "match-1",
        status: "Live",
        server_id: "server-1",
        server: {
          id: "server-1",
          game_server_node_id: "node-1",
        },
      },
    });

    const setServerError = jest
      .spyOn(service as any, "setServerError")
      .mockResolvedValue(undefined);
    const assignOnDemandServer = jest
      .spyOn(service as any, "assignOnDemandServer")
      .mockResolvedValue(true);
    const delayCheckOnDemandServer = jest
      .spyOn(service, "delayCheckOnDemandServer")
      .mockResolvedValue(undefined);

    await expect(service.rebootOnDemandServer("match-1")).resolves.toBeUndefined();

    expect(setServerError).toHaveBeenCalledWith("match-1", null);
    expect(assignOnDemandServer).toHaveBeenCalledWith("match-1", {
      preserveMatchStatus: true,
    });
    expect(delayCheckOnDemandServer).toHaveBeenCalledWith("match-1");
  });

  it("rejects when the match has no assigned server", async () => {
    hasura.query.mockResolvedValue({
      matches_by_pk: {
        id: "match-1",
        status: "Live",
        server_id: null,
        server: null,
      },
    });

    await expect(service.rebootOnDemandServer("match-1")).rejects.toThrow(
      "match has no assigned server",
    );
  });

  it("rejects dedicated servers", async () => {
    hasura.query.mockResolvedValue({
      matches_by_pk: {
        id: "match-1",
        status: "Live",
        server_id: "server-1",
        server: {
          id: "server-1",
          game_server_node_id: null,
        },
      },
    });

    await expect(service.rebootOnDemandServer("match-1")).rejects.toThrow(
      "only on demand servers can be rebooted",
    );
  });

  it("rejects disallowed match statuses", async () => {
    hasura.query.mockResolvedValue({
      matches_by_pk: {
        id: "match-1",
        status: "Finished",
        server_id: "server-1",
        server: {
          id: "server-1",
          game_server_node_id: "node-1",
        },
      },
    });

    await expect(service.rebootOnDemandServer("match-1")).rejects.toThrow(
      "match server cannot be rebooted in the current match state",
    );
  });

  it("rejects when no replacement on-demand server is available", async () => {
    hasura.query.mockResolvedValue({
      matches_by_pk: {
        id: "match-1",
        status: "WaitingForServer",
        server_id: "server-1",
        server: {
          id: "server-1",
          game_server_node_id: "node-1",
        },
      },
    });

    jest.spyOn(service as any, "setServerError").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "assignOnDemandServer")
      .mockResolvedValue(false);

    await expect(service.rebootOnDemandServer("match-1")).rejects.toThrow(
      "no on demand servers are available to reboot this match",
    );
  });
});
