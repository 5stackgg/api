import { BadRequestException } from "@nestjs/common";
import {
  DedicatedServerMigrationService,
  ServerMigration,
  ServerMigrationNode,
  ServerMigrationServer,
} from "./dedicated-server-migration.service";

const node = (
  overrides: Partial<ServerMigrationNode> = {},
): ServerMigrationNode => ({
  id: "node-b",
  label: "Node B",
  enabled: true,
  status: "Online",
  node_ip: "100.64.0.2",
  update_status: null,
  build_id: 100,
  csgo_build_id: null,
  disk_available_gb: 100,
  available_dedicated_slot_count: 2,
  ...overrides,
});

describe("DedicatedServerMigrationService", () => {
  let steps: Array<string>;
  let server: ServerMigrationServer;
  let nodes: Record<string, ServerMigrationNode>;
  let migration: ServerMigration & { stale?: boolean };
  let deployed: boolean;
  let pendingDemo: boolean;
  let cacheValues: Map<string, unknown>;
  let commitError: Error | undefined;
  let postgres: { query: jest.Mock; transaction: jest.Mock };
  let fileManager: {
    serverDirectorySize: jest.Mock;
    relayServerDirectory: jest.Mock;
    deleteServerDirectory: jest.Mock;
  };
  let dedicatedServers: {
    rebuildDedicatedServer: jest.Mock;
    deploymentExists: jest.Mock;
    waitForDedicatedServerStopped: jest.Mock;
    waitForDeployment: jest.Mock;
    expectRestart: jest.Mock;
  };
  let queue: { add: jest.Mock; remove: jest.Mock; getJob: jest.Mock };
  let service: DedicatedServerMigrationService;

  const migrationUpdates = () =>
    postgres.query.mock.calls
      .filter(([sql]) => /UPDATE server_migrations/.test(sql))
      .map(([sql, bindings]) => ({ sql: sql as string, bindings }));

  const finalStatus = () => {
    const update = migrationUpdates()
      .reverse()
      .find(({ sql }) => /finished_at = now\(\)/.test(sql));

    if (!update) {
      return undefined;
    }

    return /status = 'Completed'/.test(update.sql)
      ? "Completed"
      : update.bindings[1];
  };

  beforeEach(() => {
    steps = [];
    commitError = undefined;
    cacheValues = new Map();
    deployed = true;
    pendingDemo = false;
    server = {
      id: "server-1",
      game: "cs2",
      enabled: true,
      is_dedicated: true,
      region: "EU",
      reserved_by_match_id: null,
      game_server_node_id: "node-a",
    };
    nodes = {
      "node-a": node({ id: "node-a", label: "Node A", node_ip: "100.64.0.1" }),
      "node-b": node(),
    };
    migration = {
      id: "migration-1",
      server_id: "server-1",
      from_game_server_node_id: "node-a",
      to_game_server_node_id: "node-b",
      status: "Queued",
      with_files: true,
    };

    postgres = {
      query: jest.fn(async (sql: string, bindings: Array<any> = []) => {
        if (/WHERE server_id = \$1 AND status = 'Queued'/.test(sql)) {
          if (migration.status !== "Queued") {
            return [];
          }
          migration.status = "Canceled";
          return [{ id: migration.id }];
        }
        if (/SELECT id, status FROM server_migrations/.test(sql)) {
          return ["Queued", "Stopping", "Transferring", "Finalizing"].includes(
            migration.status,
          )
            ? [{ id: migration.id, status: migration.status }]
            : [];
        }
        if (/FROM server_migrations WHERE id = \$1/.test(sql)) {
          return [migration];
        }
        if (/FROM servers WHERE id = \$1/.test(sql)) {
          if (/SELECT reserved_by_match_id/.test(sql)) {
            return [{ reserved_by_match_id: server.reserved_by_match_id }];
          }
          return [server];
        }
        if (/FROM game_server_nodes/.test(sql)) {
          return (bindings[0] as Array<string>)
            .map((id) => nodes[id])
            .filter(Boolean);
        }
        if (/UPDATE servers SET connected = false/.test(sql)) {
          steps.push("detach");
          return server.reserved_by_match_id ? [] : [{ id: server.id }];
        }
        if (/WHERE id = \$1 AND status = \$2/.test(sql)) {
          migration.status = bindings[2];
          steps.push(`status ${bindings[2]}`);
          return [{ id: migration.id }];
        }
        if (/finished_at = now\(\)/.test(sql)) {
          if (
            !["Queued", "Stopping", "Transferring", "Finalizing"].includes(
              migration.status,
            )
          ) {
            return [];
          }
          const status = /status = 'Completed'/.test(sql)
            ? "Completed"
            : bindings[1];
          migration.status = status;
          steps.push(`status ${status}`);
          return [{ id: migration.id }];
        }
        if (/FROM matches m/.test(sql)) {
          return pendingDemo ? [{ "?column?": 1 }] : [];
        }
        if (/INSERT INTO server_migrations/.test(sql)) {
          return [{ id: "migration-1" }];
        }
        return [];
      }),
      transaction: jest.fn(async (fn) => {
        if (commitError) {
          throw commitError;
        }
        const client = {
          query: jest.fn(async (sql: string, bindings: Array<any>) => {
            if (/SET status = 'Finalizing'/.test(sql)) {
              if (!["Stopping", "Transferring"].includes(migration.status)) {
                return { rowCount: 0 };
              }
              migration.status = "Finalizing";
              return { rowCount: 1 };
            }
            if (/UPDATE servers SET game_server_node_id/.test(sql)) {
              server.game_server_node_id = bindings[1];
              steps.push(`commit ${bindings[1]}`);
            }
            return { rowCount: 1 };
          }),
        };
        return fn(client);
      }),
    };

    fileManager = {
      serverDirectorySize: jest.fn(async () => ({
        exists: true,
        entries: 10,
        bytes: 1000,
        archiveBytes: 6000,
        skipped: [],
      })),
      relayServerDirectory: jest.fn(async () => {
        steps.push("relay");
        return { entries: 10, bytes: 1000 };
      }),
      deleteServerDirectory: jest.fn(async (nodeId: string) => {
        steps.push(`delete ${nodeId}`);
        return { existed: true };
      }),
    };

    dedicatedServers = {
      rebuildDedicatedServer: jest.fn(async (id: string, start = true) => {
        steps.push(`rebuild ${start ? "start" : "stop"}`);
        deployed = start;
        return true;
      }),
      deploymentExists: jest.fn(async () => deployed),
      waitForDedicatedServerStopped: jest.fn(async () => {
        steps.push("stopped");
      }),
      waitForDeployment: jest.fn(async () => true),
      expectRestart: jest.fn(),
    };

    queue = {
      add: jest.fn(),
      remove: jest.fn(async () => undefined),
      getJob: jest.fn(),
    };

    const cache = {
      acquireLock: jest.fn(
        async (key: string, _seconds: number, value = "1") => {
          if (cacheValues.has(key)) {
            return false;
          }
          cacheValues.set(key, value);
          return true;
        },
      ),
      getRaw: jest.fn(async (key: string) => cacheValues.get(key) ?? null),
      refreshLock: jest.fn(),
      forget: jest.fn(async (...keys: Array<string>) => {
        keys.forEach((key) => cacheValues.delete(key));
      }),
      has: jest.fn(async (key: string) => cacheValues.has(key)),
      put: jest.fn(async (key: string, value: unknown) => {
        cacheValues.set(key, value);
      }),
      lock: jest.fn(async (_key: string, callback: () => Promise<unknown>) =>
        callback(),
      ),
    };

    service = new DedicatedServerMigrationService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      postgres as never,
      cache as never,
      { disconnect: jest.fn(async () => steps.push("rcon closed")) } as never,
      fileManager as never,
      dedicatedServers as never,
      queue as never,
    );
  });

  describe("moving a server", () => {
    it("stops it, copies its files across, switches node and clears the old copy", async () => {
      await service.run("migration-1");

      expect(steps).toEqual([
        "status Stopping",
        "detach",
        "rebuild stop",
        "stopped",
        "rcon closed",
        "status Transferring",
        "relay",
        "commit node-b",
        "delete node-a",
        "status Completed",
      ]);
      expect(fileManager.relayServerDirectory).toHaveBeenCalledWith(
        "node-a",
        "node-b",
        "server-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("starts a fresh copy on the new node when moved without its files", async () => {
      migration.with_files = false;
      nodes["node-a"] = node({ id: "node-a", status: "Offline" });

      await service.run("migration-1");

      expect(fileManager.relayServerDirectory).not.toHaveBeenCalled();
      expect(steps).toEqual([
        "status Stopping",
        "detach",
        "rebuild stop",
        "stopped",
        "rcon closed",
        "delete node-b",
        "commit node-b",
        "status Completed",
      ]);
      expect(
        dedicatedServers.waitForDedicatedServerStopped,
      ).toHaveBeenCalledWith(
        "server-1",
        expect.objectContaining({
          acceptTerminating: true,
        }),
      );
    });

    it("redeploys on the new node itself when the node change did not", async () => {
      dedicatedServers.waitForDeployment.mockResolvedValue(false);

      await service.run("migration-1");

      expect(steps).toContain("rebuild start");
      expect(steps.indexOf("rebuild start")).toBeGreaterThan(
        steps.indexOf("commit node-b"),
      );
    });

    it("still finishes when the old copy cannot be removed", async () => {
      fileManager.deleteServerDirectory.mockImplementation(async () => {
        throw new Error("connection refused");
      });

      await service.run("migration-1");

      expect(finalStatus()).toBe("Completed");
      expect(
        migrationUpdates().some(({ bindings }) =>
          String(bindings?.[1]).includes("connection refused"),
        ),
      ).toBe(true);
    });

    it("does nothing for a move that was canceled before it started", async () => {
      migration.status = "Canceled";

      await service.run("migration-1");

      expect(steps).toEqual([]);
    });
  });

  describe("when it goes wrong", () => {
    it("puts the server back where it was when the node switch fails", async () => {
      commitError = new Error(
        "No available game node server found on this node",
      );

      await service.run("migration-1");

      expect(steps.slice(-3)).toEqual([
        "status Failed",
        "delete node-b",
        "rebuild start",
      ]);
      expect(server.game_server_node_id).toBe("node-a");
      expect(migrationUpdates().at(-1).bindings.slice(0, 3)).toEqual([
        "migration-1",
        "Failed",
        "No available game node server found on this node",
      ]);
    });

    it("stops mid-transfer when canceled and records it as canceled", async () => {
      fileManager.relayServerDirectory.mockImplementation(
        async (_from, _to, _server, options: { signal: AbortSignal }) => {
          steps.push("relay");
          await service.requestCancel("server-1");
          await new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () =>
              reject(options.signal.reason),
            );
          });
        },
      );

      await service.run("migration-1");

      expect(steps).not.toContain("commit node-b");
      expect(steps.slice(-3)).toEqual([
        "status Canceled",
        "delete node-b",
        "rebuild start",
      ]);
    }, 10_000);

    it("leaves a server hosting a match running when the move cannot stop it", async () => {
      server.reserved_by_match_id = "match-1";

      await service.run("migration-1");

      expect(steps).toEqual([
        "status Stopping",
        "detach",
        "status Failed",
        "delete node-b",
      ]);
      expect(dedicatedServers.rebuildDedicatedServer).not.toHaveBeenCalled();
    });

    it("does not stop a server that is still uploading its last demo", async () => {
      pendingDemo = true;

      await service.run("migration-1");

      expect(dedicatedServers.rebuildDedicatedServer).not.toHaveBeenCalled();
      expect(migrationUpdates().at(-1).bindings.slice(0, 3)).toEqual([
        "migration-1",
        "Failed",
        "The server is still uploading a demo from its last match",
      ]);
    });

    it("honours a cancel that lands just before the switch", async () => {
      fileManager.relayServerDirectory.mockImplementation(async () => {
        steps.push("relay");
        await service.requestCancel("server-1");
      });

      await service.run("migration-1");

      expect(steps).not.toContain("commit node-b");
      expect(steps.slice(-3)).toEqual([
        "status Canceled",
        "delete node-b",
        "rebuild start",
      ]);
    });

    it("does not switch nodes once another worker has ended the move", async () => {
      fileManager.relayServerDirectory.mockImplementation(async () => {
        steps.push("relay");
        migration.status = "Failed";
      });

      await service.run("migration-1");

      expect(steps).not.toContain("commit node-b");
      expect(steps.at(-1)).toBe("delete node-b");
      expect(steps).not.toContain("rebuild start");
      expect(server.game_server_node_id).toBe("node-a");
    });

    it("warns when the server does not come up on its new node", async () => {
      dedicatedServers.waitForDeployment.mockResolvedValue(false);
      dedicatedServers.rebuildDedicatedServer.mockImplementation(
        async (_id: string, start = true) => {
          steps.push(`rebuild ${start ? "start" : "stop"}`);
          return !start;
        },
      );

      await service.run("migration-1");

      expect(finalStatus()).toBe("Completed");
      expect(
        migrationUpdates().some(({ bindings }) =>
          String(bindings?.[1]).includes("did not start on node-b"),
        ),
      ).toBe(true);
    });

    it("does not bring back a server that was disabled before the move", async () => {
      server.enabled = false;
      fileManager.relayServerDirectory.mockRejectedValue(
        new Error("socket hang up"),
      );

      await service.run("migration-1");

      expect(steps.slice(-2)).toEqual(["status Failed", "delete node-b"]);
      expect(steps).not.toContain("rebuild start");
    });

    it("refuses to continue if the server was given a match while stopping", async () => {
      dedicatedServers.waitForDedicatedServerStopped.mockImplementation(
        async () => {
          server.reserved_by_match_id = "match-1";
        },
      );

      await service.run("migration-1");

      expect(fileManager.relayServerDirectory).not.toHaveBeenCalled();
      expect(migrationUpdates().at(-1).bindings.slice(0, 3)).toEqual([
        "migration-1",
        "Failed",
        "The server was given a match while it was stopping",
      ]);
    });
  });

  describe("recovering an interrupted move", () => {
    it("rolls back a move that had not switched nodes yet", async () => {
      migration.status = "Transferring";
      migration.stale = true;
      deployed = false;

      await service.run("migration-1");

      expect(fileManager.relayServerDirectory).not.toHaveBeenCalled();
      expect(steps).toEqual([
        "status Failed",
        "delete node-b",
        "rebuild start",
      ]);
    });

    it("leaves a redelivered job to the run that is still working on it", async () => {
      migration.status = "Transferring";
      migration.stale = false;

      await service.run("migration-1");

      expect(steps).toEqual([]);
    });

    it("finishes a move that had already switched nodes", async () => {
      migration.status = "Finalizing";
      migration.stale = true;
      server.game_server_node_id = "node-b";

      await service.run("migration-1");

      expect(steps).toEqual(["delete node-a", "status Completed"]);
    });

    it("leaves a queued move alone while its job is still waiting", async () => {
      postgres.query.mockImplementationOnce(async () => [migration]);
      queue.getJob.mockResolvedValue({ getState: async () => "waiting" });

      await service.sweep();

      expect(steps).toEqual([]);
    });
  });

  describe("requesting a move", () => {
    const request = (withoutFiles = false) =>
      service.requestMove(
        { steam_id: "76561198000000000" } as never,
        "server-1",
        "node-b",
        withoutFiles,
      );

    it("queues a move to an eligible node", async () => {
      await request();

      expect(queue.add).toHaveBeenCalledWith(
        "MigrateDedicatedServer",
        { migrationId: "migration-1" },
        expect.objectContaining({ jobId: "migrate:migration-1" }),
      );
    });

    it("asks for a move without files when the current node is offline", async () => {
      nodes["node-a"] = node({
        id: "node-a",
        label: "Node A",
        status: "Offline",
      });

      await expect(request()).rejects.toThrow(/Node A is offline/);
      await expect(request(true)).resolves.toBe("migration-1");
    });

    it("keeps the files when the current node is online", async () => {
      await expect(request(true)).rejects.toThrow(BadRequestException);
    });

    it("refuses a node without room for the files", async () => {
      nodes["node-b"] = node({ disk_available_gb: 1 });
      fileManager.serverDirectorySize.mockResolvedValue({
        exists: true,
        entries: 1,
        bytes: 512 * 1024 * 1024,
        archiveBytes: 0,
        skipped: [],
      });

      await expect(request()).rejects.toThrow(/enough free disk space/);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("refuses a server that is hosting a match", async () => {
      server.reserved_by_match_id = "match-1";

      await expect(request()).rejects.toThrow(/hosting a match/);
    });

    it("reports a move already in flight", async () => {
      postgres.query.mockImplementation(async (sql: string) => {
        if (/INSERT INTO server_migrations/.test(sql)) {
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }
        if (/FROM servers/.test(sql)) {
          return [server];
        }
        if (/FROM game_server_nodes/.test(sql)) {
          return Object.values(nodes);
        }
        return [];
      });

      await expect(request()).rejects.toThrow(/already being moved/);
    });
  });

  describe("canceling", () => {
    it("drops a move that has not started", async () => {
      await service.requestCancel("server-1");

      expect(migration.status).toBe("Canceled");
      expect(queue.remove).toHaveBeenCalledWith("migrate:migration-1");
    });

    it("refuses once the server is switching nodes", async () => {
      migration.status = "Finalizing";

      await expect(service.requestCancel("server-1")).rejects.toThrow(
        /can no longer be canceled/,
      );
    });
  });

  describe("moveTargetIneligibility", () => {
    const cs2 = { game: "cs2", game_server_node_id: "node-a" };

    it.each([
      ["the current node", node({ id: "node-a" }), cs2, /already on/],
      ["a disabled node", node({ enabled: false }), cs2, /disabled/],
      ["an offline node", node({ status: "Offline" }), cs2, /Offline/],
      [
        "a node without an address",
        node({ node_ip: null }),
        cs2,
        /unreachable/,
      ],
      [
        "a node updating CS2",
        node({ update_status: "Downloading" }),
        cs2,
        /updating/,
      ],
      ["a node without CS2", node({ build_id: null }), cs2, /CS2/],
      [
        "a node without CS:GO for a CS:GO server",
        node(),
        { game: "csgo", game_server_node_id: "node-a" },
        /CS:GO/,
      ],
      [
        "a full node",
        node({ available_dedicated_slot_count: 0 }),
        cs2,
        /free server slots/,
      ],
    ])("rules out %s", (_label, candidate, target, reason) => {
      expect(
        DedicatedServerMigrationService.moveTargetIneligibility(
          candidate,
          target,
        ),
      ).toMatch(reason);
    });

    it("accepts a node that is not taking new matches", () => {
      expect(
        DedicatedServerMigrationService.moveTargetIneligibility(
          node({ status: "NotAcceptingNewMatches" }),
          cs2,
        ),
      ).toBeNull();
    });
  });
});
