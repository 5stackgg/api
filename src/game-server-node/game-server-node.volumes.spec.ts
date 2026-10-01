jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ctor: new () => unknown) {
      return new ctor();
    }
  },
}));

import { GameServerNodeService } from "./game-server-node.service";

describe("GameServerNodeService volumes of a registering node", () => {
  const NODE_ID = "a1b2c3d4";
  const CS_BUILD = 21000000;
  const CSGO_BUILD = 7000000;

  let service: GameServerNodeService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let createVolumes: jest.SpyInstance;
  let create: jest.SpyInstance;

  const ping = (csgoBuild: number | undefined) =>
    service.updateStatus(
      NODE_ID,
      "10.0.0.2",
      "192.168.1.2",
      "203.0.113.2",
      CS_BUILD,
      csgoBuild,
      false,
      false,
      { sockets: 1, coresPerSocket: 8, threadsPerCore: 2 },
      { governor: "performance", cpus: {} },
      { cpus: {}, frequency: 0 },
      undefined,
      "Online",
    );

  beforeEach(() => {
    hasura = {
      query: jest.fn().mockResolvedValue({ game_server_nodes_by_pk: null }),
      mutation: jest.fn().mockResolvedValue({}),
    };

    service = new GameServerNodeService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {
        get: (key: string) =>
          key === "gameServers" ? { namespace: "5stack" } : {},
      } as any,
      hasura as any,
      { getConnection: () => ({}) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
    );

    createVolumes = jest
      .spyOn(service as any, "createVolumes")
      .mockResolvedValue(undefined);
    create = jest.spyOn(service, "create").mockResolvedValue(undefined);
  });

  it("creates the CS:GO volume too for a node without a row that still has its CS:GO install", async () => {
    await ping(CSGO_BUILD);

    expect(createVolumes).toHaveBeenCalledTimes(2);
    expect(createVolumes).toHaveBeenCalledWith(NODE_ID);
    expect(createVolumes).toHaveBeenCalledWith(NODE_ID, "csgo");
    expect(create).toHaveBeenCalledWith(undefined, NODE_ID, "Online");
  });

  it("creates no CS:GO volume for a node without a CS:GO install", async () => {
    await ping(undefined);

    expect(createVolumes).toHaveBeenCalledTimes(1);
    expect(createVolumes).toHaveBeenCalledWith(NODE_ID);
  });

  it("creates no volumes for a node that has a row", async () => {
    hasura.query.mockResolvedValue({
      game_server_nodes_by_pk: {
        status: "Online",
        build_id: CS_BUILD,
        csgo_build_id: CSGO_BUILD,
        update_status: null,
        enabled: true,
        servers: [],
      },
    });

    await ping(CSGO_BUILD);

    expect(createVolumes).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
