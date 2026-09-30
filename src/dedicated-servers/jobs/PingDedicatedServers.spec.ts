import { PingDedicatedServers } from "./PingDedicatedServers";

describe("PingDedicatedServers", () => {
  let servers: Array<{
    id: string;
    game_server_node: { status: string } | null;
  }>;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let dedicatedServers: {
    pingDedicatedServer: jest.Mock;
    expectRestart: jest.Mock;
  };
  let job: PingDedicatedServers;

  beforeEach(() => {
    hasura = {
      query: jest.fn(async () => ({ servers })),
      mutation: jest.fn().mockResolvedValue({}),
    };
    dedicatedServers = {
      pingDedicatedServer: jest.fn().mockResolvedValue(undefined),
      expectRestart: jest.fn().mockResolvedValue(undefined),
    };
    job = new PingDedicatedServers(hasura as any, dedicatedServers as any);
  });

  it("pings a server on a node that stopped accepting new matches", async () => {
    servers = [
      {
        id: "server-1",
        game_server_node: { status: "NotAcceptingNewMatches" },
      },
    ];

    await job.process();

    expect(dedicatedServers.pingDedicatedServer).toHaveBeenCalledWith(
      "server-1",
    );
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("marks a server on an offline node disconnected and waits for it to reboot", async () => {
    servers = [{ id: "server-1", game_server_node: { status: "Offline" } }];

    await job.process();

    expect(dedicatedServers.pingDedicatedServer).not.toHaveBeenCalled();
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_servers_by_pk: expect.objectContaining({
          __args: {
            pk_columns: { id: "server-1" },
            _set: { connected: false },
          },
        }),
      }),
    );
    expect(dedicatedServers.expectRestart).toHaveBeenCalledWith("server-1");
  });

  it("pings an external server", async () => {
    servers = [{ id: "server-1", game_server_node: null }];

    await job.process();

    expect(dedicatedServers.pingDedicatedServer).toHaveBeenCalledWith(
      "server-1",
    );
  });
});
