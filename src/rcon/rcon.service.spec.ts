import { RconService } from "./rcon.service";

jest.mock("rcon-client", () => ({
  Rcon: jest.fn().mockImplementation(() => {
    const client: Record<string, unknown> = {
      authenticated: false,
      connect: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      end: jest.fn(),
    };
    client.on = jest.fn(() => client);
    client.off = jest.fn(() => client);
    return client;
  }),
}));

describe("RconService connect failure", () => {
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let notifications: { send: jest.Mock };
  let service: RconService;

  const dedicatedServer = (enabled: boolean, type = "Ranked") => ({
    host: "10.0.0.1",
    port: 27015,
    type,
    label: "Retakes #1",
    region: "us-east",
    enabled,
    is_dedicated: true,
    rcon_status: true,
    rcon_password: "secret",
    game_server_node: null as null,
  });

  let graceRemaining: number;

  beforeEach(() => {
    graceRemaining = -2;
    hasura = {
      query: jest.fn(),
      mutation: jest.fn().mockResolvedValue({}),
    };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };
    service = new RconService(
      hasura as any,
      { decrypt: jest.fn().mockResolvedValue("secret") } as any,
      notifications as any,
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
      {} as any,
      {
        getConnection: () => ({ pttl: jest.fn(async () => graceRemaining) }),
      } as any,
      {} as any,
    );
  });

  it("alerts when an enabled Ranked server's RCON goes down", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: dedicatedServer(true) });

    await service.connect("server-1");

    expect(notifications.send).toHaveBeenCalledWith(
      "DedicatedServerRconStatus",
      expect.objectContaining({ title: "Dedicated Server RCON Error" }),
      undefined,
      expect.any(Number),
    );
  });

  it("records the failure without alerting for a disabled server", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: dedicatedServer(false) });

    await service.connect("server-1");

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_servers_by_pk: expect.objectContaining({
          __args: expect.objectContaining({ _set: { rcon_status: false } }),
        }),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("leaves other dedicated servers to the minute ping", async () => {
    hasura.query.mockResolvedValue({
      servers_by_pk: dedicatedServer(true, "Retake"),
    });

    await service.connect("server-1");

    expect(hasura.mutation).toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("stays quiet while a Ranked server is restarting", async () => {
    hasura.query.mockResolvedValue({ servers_by_pk: dedicatedServer(true) });
    graceRemaining = 2 * 60 * 1000;

    await service.connect("server-1");

    expect(hasura.mutation).toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });
});
