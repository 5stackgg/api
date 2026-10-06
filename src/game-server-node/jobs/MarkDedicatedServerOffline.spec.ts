import { DelayedError } from "bullmq";
import { MarkDedicatedServerOffline } from "./MarkDedicatedServerOffline";

type Server = {
  label: string;
  enabled: boolean;
  is_dedicated: boolean;
  offline_at: string | null;
  game_server_node: { status: string } | null;
};

const server = (fields: Partial<Server> = {}): Server => ({
  label: "Retakes #1",
  enabled: true,
  is_dedicated: true,
  offline_at: null,
  game_server_node: null,
  ...fields,
});

describe("MarkDedicatedServerOffline", () => {
  let row: Server | null;
  let now: number;
  let graceUntil: number | null;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let notifications: { send: jest.Mock };
  let redis: { pttl: jest.Mock; set: jest.Mock };
  let queued: { moveToDelayed: jest.Mock };
  let job: MarkDedicatedServerOffline;

  beforeEach(() => {
    now = Date.now();
    graceUntil = null;
    hasura = {
      query: jest.fn(async () => ({ servers_by_pk: row && { ...row } })),
      mutation: jest.fn().mockResolvedValue({}),
    };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };
    redis = {
      pttl: jest.fn(async () =>
        graceUntil && graceUntil > now ? graceUntil - now : -2,
      ),
      set: jest.fn(async (_key: string, _value: string, _px: string, ms) => {
        graceUntil = now + ms;
        return "OK";
      }),
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

  const offlineWrite = () =>
    hasura.mutation.mock.calls[0]?.[0].update_servers_by_pk.__args._set;

  it("alerts when an enabled dedicated server stops heartbeating", async () => {
    row = server();

    await run();

    expect(offlineWrite()).toEqual({
      connected: false,
      hibernating: false,
      offline_at: expect.any(String),
    });
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

    expect(offlineWrite().connected).toBe(false);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("stays quiet for a match server", async () => {
    row = server({ is_dedicated: false });

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

  it("keeps the time the server first went offline", async () => {
    row = server({ offline_at: "2026-09-30T10:00:00.000Z" });

    await run();

    expect(offlineWrite().offline_at).toBe("2026-09-30T10:00:00.000Z");
  });

  it("marks a restarting server offline but holds the alert until the grace runs out", async () => {
    row = server();
    graceUntil = now + 3 * 60 * 1000;

    await expect(run()).rejects.toThrow(DelayedError);

    expect(offlineWrite().connected).toBe(false);
    const [[until, token]] = queued.moveToDelayed.mock.calls;
    expect(token).toBe("token");
    expect(until - Date.now()).toBeGreaterThanOrEqual(3 * 60 * 1000 - 1000);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("reports a restarted server that is still down once the grace has run out", async () => {
    row = server();
    graceUntil = now + 3 * 60 * 1000;
    await expect(run()).rejects.toThrow(DelayedError);

    now += 3 * 60 * 1000 + 5 * 1000;
    await run();

    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it("leaves an outage to the node, then reports the server if it never came back", async () => {
    row = server({ game_server_node: { status: "Offline" } });

    await expect(run()).rejects.toThrow(DelayedError);
    expect(redis.set).toHaveBeenCalledWith(
      "dedicated-servers:restarting:server-1",
      "1",
      "PX",
      5 * 60 * 1000,
    );
    expect(notifications.send).not.toHaveBeenCalled();

    now += 5 * 60 * 1000;
    await expect(run()).rejects.toThrow(DelayedError);
    expect(notifications.send).not.toHaveBeenCalled();

    row.game_server_node = { status: "Online" };
    now += 5 * 60 * 1000 + 5 * 1000;
    await run();

    expect(notifications.send).toHaveBeenCalledTimes(1);
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
