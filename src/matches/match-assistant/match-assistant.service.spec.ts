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
  let loggingService: {
    getJobBootDiagnostics: jest.Mock;
  };
  let queue: {
    add: jest.Mock;
  };

  beforeEach(() => {
    hasura = {
      query: jest.fn(),
      mutation: jest.fn(),
    };
    loggingService = {
      getJobBootDiagnostics: jest.fn(),
    };
    queue = {
      add: jest.fn(),
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
      loggingService as any,
      queue as any,
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

    await expect(
      service.rebootOnDemandServer("match-1"),
    ).resolves.toBeUndefined();

    expect(setServerError).toHaveBeenCalledWith("match-1", null);
    expect(assignOnDemandServer).toHaveBeenCalledWith("match-1", {
      preserveMatchStatus: true,
    });
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
    jest.spyOn(service as any, "assignOnDemandServer").mockResolvedValue(false);

    await expect(service.rebootOnDemandServer("match-1")).rejects.toThrow(
      "no on demand servers are available to reboot this match",
    );
  });

  it("does not mark on-demand matches Live immediately after assignment", async () => {
    hasura.query.mockResolvedValue({
      matches_by_pk: {
        id: "match-1",
        region: "USE",
        options: {
          prefer_dedicated_server: false,
        },
      },
    });

    jest.spyOn(service as any, "assignOnDemandServer").mockResolvedValue(true);
    const startMatch = jest
      .spyOn(service as any, "startMatch")
      .mockResolvedValue(undefined);

    await expect(service.assignServer("match-1")).resolves.toBeUndefined();

    expect(startMatch).not.toHaveBeenCalled();
  });

  it("schedules the next on-demand server boot check after 15 seconds", async () => {
    await service.delayCheckOnDemandServer("match-1");

    expect(queue.add).toHaveBeenCalledWith(
      "CheckOnDemandServerJob",
      {
        matchId: "match-1",
      },
      expect.objectContaining({
        delay: 15 * 1000,
        jobId: "match.match-1.server",
      }),
    );
  });

  it("promotes WaitingForServer matches to Live after the first successful ping", async () => {
    hasura.query
      .mockResolvedValueOnce({
        matches_by_pk: {
          id: "match-1",
          status: "WaitingForServer",
          server_id: "server-1",
          server: {
            id: "server-1",
            boot_status: "WaitingForPing",
            boot_status_detail:
              "Server pod is running. Waiting for the first server ping.",
            connected: true,
            game_server_node_id: "node-1",
            is_dedicated: false,
            reserved_by_match_id: "match-1",
          },
        },
      })
      .mockResolvedValueOnce({
        matches_by_pk: {
          server_error: "old error",
        },
      })
      .mockResolvedValueOnce({
        matches_by_pk: {
          server_error: null,
        },
      });

    hasura.mutation.mockResolvedValue({});

    const updateMatchStatus = jest
      .spyOn(service, "updateMatchStatus")
      .mockResolvedValue(undefined);
    const sendServerMatchId = jest
      .spyOn(service, "sendServerMatchId")
      .mockResolvedValue(undefined);

    await expect(service.monitorOnDemandServerBoot("match-1")).resolves.toBe(
      "ready",
    );

    expect(updateMatchStatus).toHaveBeenCalledWith("match-1", "Live");
    expect(sendServerMatchId).toHaveBeenCalledWith("match-1");
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_servers_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            pk_columns: {
              id: "server-1",
            },
            _set: {
              boot_status: null,
              boot_status_detail: null,
            },
          }),
        }),
      }),
    );
  });

  it("stores terminal boot diagnostics and stops monitoring", async () => {
    hasura.query
      .mockResolvedValueOnce({
        matches_by_pk: {
          id: "match-1",
          status: "WaitingForServer",
          server_id: "server-1",
          server: {
            id: "server-1",
            boot_status: null,
            boot_status_detail: null,
            connected: false,
            game_server_node_id: "node-1",
            is_dedicated: false,
            reserved_by_match_id: "match-1",
          },
        },
      })
      .mockResolvedValueOnce({
        matches_by_pk: {
          server_error: null,
        },
      });

    loggingService.getJobBootDiagnostics.mockResolvedValue({
      status: "Failed",
      detail: "ImagePullBackOff: Back-off pulling image",
      terminal: true,
      job: null,
      pod: null,
      events: [],
    });
    hasura.mutation.mockResolvedValue({});

    await expect(service.monitorOnDemandServerBoot("match-1")).resolves.toBe(
      "stopped",
    );

    expect(loggingService.getJobBootDiagnostics).toHaveBeenCalledWith(
      "m-match-1",
    );
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_servers_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            pk_columns: {
              id: "server-1",
            },
            _set: {
              boot_status: "Failed",
              boot_status_detail: "ImagePullBackOff: Back-off pulling image",
            },
          }),
        }),
      }),
    );
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              server_error: "ImagePullBackOff: Back-off pulling image",
            },
          }),
        }),
      }),
    );
  });

  it("stores non-terminal boot diagnostics without showing a match error", async () => {
    hasura.query
      .mockResolvedValueOnce({
        matches_by_pk: {
          id: "match-1",
          status: "WaitingForServer",
          server_id: "server-1",
          server: {
            id: "server-1",
            boot_status: "Creating",
            boot_status_detail:
              "Waiting for Kubernetes to create the match server pod.",
            connected: false,
            game_server_node_id: "node-1",
            is_dedicated: false,
            reserved_by_match_id: "match-1",
          },
        },
      })
      .mockResolvedValueOnce({
        matches_by_pk: {
          server_error: null,
        },
      });

    loggingService.getJobBootDiagnostics.mockResolvedValue({
      status: "Creating",
      detail: "Waiting for Kubernetes to create the match server pod.",
      terminal: false,
      job: null,
      pod: null,
      events: [],
    });
    hasura.mutation.mockResolvedValue({});

    await expect(service.monitorOnDemandServerBoot("match-1")).resolves.toBe(
      "pending",
    );

    expect(hasura.mutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              server_error:
                "Waiting for Kubernetes to create the match server pod.",
            },
          }),
        }),
      }),
    );
  });

  it("stores monitor inspection errors without showing a match error", async () => {
    hasura.query
      .mockResolvedValueOnce({
        matches_by_pk: {
          id: "match-1",
          status: "WaitingForServer",
          server_id: "server-1",
          server: {
            id: "server-1",
            boot_status: "Creating",
            boot_status_detail:
              "Waiting for Kubernetes to create the match server pod.",
            connected: false,
            game_server_node_id: "node-1",
            is_dedicated: false,
            reserved_by_match_id: "match-1",
          },
        },
      })
      .mockResolvedValueOnce({
        matches_by_pk: {
          server_error: null,
        },
      });

    loggingService.getJobBootDiagnostics.mockRejectedValue(
      new Error("k8s unavailable"),
    );
    hasura.mutation.mockResolvedValue({});

    await expect(service.monitorOnDemandServerBoot("match-1")).resolves.toBe(
      "pending",
    );

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_servers_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            pk_columns: {
              id: "server-1",
            },
            _set: {
              boot_status: "Creating",
              boot_status_detail: "k8s unavailable",
            },
          }),
        }),
      }),
    );
    expect(hasura.mutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              server_error: "k8s unavailable",
            },
          }),
        }),
      }),
    );
  });
});
