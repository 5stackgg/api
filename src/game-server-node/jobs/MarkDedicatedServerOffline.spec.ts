import { DelayedError } from "bullmq";
import { MarkDedicatedServerOffline } from "./MarkDedicatedServerOffline";

type Server = {
  label: string;
  enabled: boolean;
  is_dedicated: boolean;
  game_server_node: { status: string } | null;
};

const server = (fields: Partial<Server> = {}): Server => ({
  label: "Retakes #1",
  enabled: true,
  is_dedicated: true,
  game_server_node: null,
  ...fields,
});

describe("MarkDedicatedServerOffline", () => {
  let row: Server | null;
  let graceRemaining: number;
  let hasura: { mutation: jest.Mock };
  let notifications: { send: jest.Mock };
  let redis: { pttl: jest.Mock; set: jest.Mock };
  let job: MarkDedicatedServerOffline;
  let queued: { moveToDelayed: jest.Mock };

  beforeEach(() => {
    graceRemaining = -2;
    hasura = {
      mutation: jest.fn(async () => ({ update_servers_by_pk: row })),
    };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };
    redis = {
      pttl: jest.fn(async () => graceRemaining),
      set: jest.fn().mockResolvedValue("OK"),
    };
    queued = { moveToDelayed: jest.fn().mockResolvedValue(undefined) };
    job = new MarkDedicatedServerOffline(
      hasura as any,
      notifications as any,
      { getConnection: () => redis } as any,
    );
  });

  const run = () =>
    job.process({
      data: { serverId: "server-1" },
      token: "token",
      ...queued,
    } as any);

  it("alerts when an enabled dedicated server stops heartbeating", async () => {
    row = server();

    await run();

    expect(hasura.mutation).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledWith(
      "DedicatedServerStatus",
      expect.objectContaining({ title: "Dedicated Server Offline" }),
      undefined,
      expect.any(Number),
    );
  });

  it("marks a disabled server offline without alerting", async () => {
    row = server({ enabled: false });

    await run();

    expect(hasura.mutation).toHaveBeenCalledTimes(1);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("stays quiet for a match server", async () => {
    row = server({ is_dedicated: false });

    await run();

    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("leaves a server on an offline node to the node's own alert", async () => {
    row = server({ game_server_node: { status: "Offline" } });

    await run();

    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("alerts for a server that crashed on a node that is up", async () => {
    row = server({ game_server_node: { status: "NotAcceptingNewMatches" } });

    await run();

    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it("does not throw for a server deleted before the job ran", async () => {
    row = null;

    await expect(run()).resolves.toBeUndefined();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("holds a server being restarted until the grace runs out", async () => {
    row = server();
    graceRemaining = 3 * 60 * 1000;

    await expect(run()).rejects.toThrow(DelayedError);

    expect(queued.moveToDelayed).toHaveBeenCalledWith(
      expect.any(Number),
      "token",
    );
    const [[until]] = queued.moveToDelayed.mock.calls;
    expect(until - Date.now()).toBeGreaterThanOrEqual(3 * 60 * 1000);
    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("reports a restarted server that never came back", async () => {
    row = server();
    graceRemaining = -2;

    await run();

    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it("gives a restart five minutes", async () => {
    await MarkDedicatedServerOffline.expectRestart(redis as any, "server-1");

    expect(redis.set).toHaveBeenCalledWith(
      "dedicated-servers:restarting:server-1",
      "1",
      "PX",
      5 * 60 * 1000,
    );
  });

  describe("delayFor", () => {
    // When a node dies, its servers' last ping (every 15s) can come up to 15s
    // before the node's own last ping, whose offline job then fires at +90s.
    it("outlasts the node's offline timer for a node-hosted dedicated server", () => {
      expect(
        MarkDedicatedServerOffline.delayFor({
          is_dedicated: true,
          game_server_node_id: "node-1",
        }),
      ).toBeGreaterThan(90 * 1000 + 15 * 1000);
    });

    it("keeps 90s for an external dedicated server", () => {
      expect(
        MarkDedicatedServerOffline.delayFor({
          is_dedicated: true,
          game_server_node_id: null,
        }),
      ).toBe(90 * 1000);
    });

    it("keeps 90s for a match server", () => {
      expect(
        MarkDedicatedServerOffline.delayFor({
          is_dedicated: false,
          game_server_node_id: "node-1",
        }),
      ).toBe(90 * 1000);
    });
  });
});
