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
  let scheduledMatchesQueue: {
    add: jest.Mock;
    getDelayed: jest.Mock;
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
    scheduledMatchesQueue = {
      add: jest.fn(),
      getDelayed: jest.fn(async (): Promise<unknown[]> => []),
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
      {
        resolveGameServerPluginImage: jest.fn(
          async () => "ghcr.io/5stackgg/game-server-sw:latest",
        ),
        resolvePluginRuntime: jest.fn(async () => "swiftlys2"),
      } as any,
      {
        resolveForServer: jest.fn(async (): Promise<null> => null),
      } as any,
      queue as any,
      scheduledMatchesQueue as any,
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

  // A dedicated server runs the match plugin; the utility practice plugin ships
  // only in the on-demand image. Falling back to one gave a practice session a
  // connect string -- so the website read "ready to join" -- for a box that can
  // never answer GET /utility/session, which is what turns the session Ready.
  it("never falls back to a dedicated server for a practice match", async () => {
    hasura.query.mockResolvedValue({
      matches_by_pk: {
        id: "match-1",
        region: "USE",
        source: "practice",
        options: {
          prefer_dedicated_server: false,
        },
      },
    });

    jest.spyOn(service as any, "assignOnDemandServer").mockResolvedValue(false);
    const assignDedicated = jest
      .spyOn(service as any, "assignDedicatedServer")
      .mockResolvedValue(true);
    const updateMatchStatus = jest
      .spyOn(service, "updateMatchStatus")
      .mockResolvedValue(undefined);

    await expect(service.assignServer("match-1")).resolves.toBeUndefined();

    expect(assignDedicated).not.toHaveBeenCalled();
    expect(updateMatchStatus).toHaveBeenCalledWith(
      "match-1",
      "WaitingForServer",
    );
  });

  // The same guard on the other side of the branch: prefer_dedicated_server is
  // an option a practice match never sets, but nothing stops it being set.
  it("ignores prefer_dedicated_server on a practice match", async () => {
    hasura.query.mockResolvedValue({
      matches_by_pk: {
        id: "match-1",
        region: "USE",
        source: "practice",
        options: {
          prefer_dedicated_server: true,
        },
      },
    });

    const assignOnDemand = jest
      .spyOn(service as any, "assignOnDemandServer")
      .mockResolvedValue(true);
    const assignDedicated = jest
      .spyOn(service as any, "assignDedicatedServer")
      .mockResolvedValue(true);

    await expect(service.assignServer("match-1")).resolves.toBeUndefined();

    expect(assignOnDemand).toHaveBeenCalled();
    expect(assignDedicated).not.toHaveBeenCalled();
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

  // The node's cached copy of a pinned tag IS the right image, and re-checking
  // the manifest before every match server can start is a registry round-trip
  // that buys nothing -- and a hard failure when the registry is rate limiting.
  describe("pulling the game-server image", () => {
    it("re-checks a channel tag and trusts a pinned one", () => {
      expect(
        MatchAssistantService.imagePullPolicyFor("ghcr.io/5stackgg/game-server:latest"),
      ).toBe("Always");
      expect(
        MatchAssistantService.imagePullPolicyFor("ghcr.io/5stackgg/game-server:dev-sw"),
      ).toBe("Always");
      expect(
        MatchAssistantService.imagePullPolicyFor("ghcr.io/5stackgg/game-server:v1.2.3"),
      ).toBe("IfNotPresent");
      // A registry port is not a tag.
      expect(
        MatchAssistantService.imagePullPolicyFor("registry:5000/game-server"),
      ).toBe("Always");
    });
  });

  // Matchmaking builds its match_options inline rather than through the match
  // form, so the platform defaults have to be read here or a "cameras on all
  // matches" operator would still get ranked games without them.
  describe("camera defaults on matchmaking-created matches", () => {
    const createMatch = async (
      settings: Array<{ name: string; value: string }>,
    ) => {
      hasura.query.mockImplementation(async (request: any) => {
        if (request.settings) {
          return { settings };
        }
        return { map_pools: [{ id: "pool-1" }] };
      });
      hasura.mutation.mockResolvedValue({
        insert_matches_one: {
          id: "match-1",
          lineup_1_id: "l1",
          lineup_2_id: "l2",
        },
      });

      await service.createMatchBasedOnType("Competitive" as any, "Ranked" as any, {
        mr: 12,
        best_of: 1,
        knife: true,
        overtime: true,
        maps: ["map-1"],
      } as any);

      return hasura.mutation.mock.calls[0][0].insert_matches_one.__args.object
        .options.data;
    };

    it("is off when the platform default is off", async () => {
      const options = await createMatch([]);

      expect(options.camera_required).toBe(false);
      expect(options.camera_allow_teammates).toBe(false);
    });

    it("requires cameras when the platform default says so", async () => {
      const options = await createMatch([
        { name: "public.camera_required_default", value: "true" },
      ]);

      expect(options.camera_required).toBe(true);
      expect(options.camera_allow_teammates).toBe(false);
    });

    it("carries the teammate default alongside it", async () => {
      const options = await createMatch([
        { name: "public.camera_required_default", value: "true" },
        { name: "public.camera_allow_teammates_default", value: "true" },
      ]);

      expect(options.camera_required).toBe(true);
      expect(options.camera_allow_teammates).toBe(true);
    });

    // Teammate viewing on its own would let players watch a feed nobody has to
    // publish, so it never turns itself on in isolation.
    it("ignores the teammate default when cameras are not required", async () => {
      const options = await createMatch([
        { name: "public.camera_allow_teammates_default", value: "true" },
      ]);

      expect(options.camera_required).toBe(false);
      expect(options.camera_allow_teammates).toBe(false);
    });
  });
});
