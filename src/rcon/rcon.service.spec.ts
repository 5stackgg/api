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

describe("RconService.listCvars", () => {
  const service = new RconService(
    {} as any,
    {} as any,
    {} as any,
    { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
    {} as any,
    { getConnection: () => ({}) } as any,
    {} as any,
  );

  const answer = (output: string) => {
    const send = jest.fn().mockResolvedValue(output);
    jest.spyOn(service, "connect").mockResolvedValue({ send } as any);
    return send;
  };

  // A plugin's cvar can hold a URL. Splitting the row on every colon cut the
  // value at "https" and pushed the rest of it into the flags.
  it("keeps a value that contains colons whole", async () => {
    const send = answer(
      "invsim_url                               : https://inventory.cstrike.app : sv, release      : Inventory Simulator API URL",
    );

    await expect(service.listCvars("server-1", "invsim_url")).resolves.toEqual([
      {
        name: "invsim_url",
        kind: "https://inventory.cstrike.app",
        flags: "sv, release",
        description: "Inventory Simulator API URL",
      },
    ]);
    expect(send).toHaveBeenCalledWith("Cvarlist invsim_url");
  });

  it("reads an empty value, empty flags and a command", async () => {
    answer(
      [
        "cvar list",
        "dm_pro_ratio                             :          : sv               : Target K/D ratio.",
        "dm_replenish_health                      : 10       :                  : Amount of health replenished on kill.",
        "sw_guns                                  : cmd      : sv               : Display available weapons.",
        "--- 3 convars/concommands for [dm_] ---",
      ].join("\n"),
    );

    await expect(service.listCvars("server-1", "dm_")).resolves.toEqual([
      {
        name: "dm_pro_ratio",
        kind: "",
        flags: "sv",
        description: "Target K/D ratio.",
      },
      {
        name: "dm_replenish_health",
        kind: "10",
        flags: "",
        description: "Amount of health replenished on kill.",
      },
      {
        name: "sw_guns",
        kind: "cmd",
        flags: "sv",
        description: "Display available weapons.",
      },
    ]);
  });

  it("fails instead of answering for a server it cannot reach", async () => {
    jest.spyOn(service, "connect").mockResolvedValue(null);

    await expect(service.listCvars("server-1", "dm_")).rejects.toThrow(
      "unable to connect",
    );
  });
});
