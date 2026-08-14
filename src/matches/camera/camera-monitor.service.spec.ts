import { Logger } from "@nestjs/common";
import { CameraMonitorService } from "./camera-monitor.service";

describe("CameraMonitorService", () => {
  const MATCH_ID = "11111111-1111-1111-1111-111111111111";
  const SERVER_ID = "22222222-2222-2222-2222-222222222222";
  const STEAM_ID = "76561198000000001";
  const OTHER_STEAM_ID = "76561198000000002";

  let redis: {
    hgetall: jest.Mock;
    hset: jest.Mock;
    expire: jest.Mock;
    get: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
  };
  let postgres: { query: jest.Mock };
  let rconClient: { send: jest.Mock };
  let rcon: { connect: jest.Mock };
  let mediaMtx: { listPaths: jest.Mock };
  let sockets: { broadcastToCluster: jest.Mock };
  let service: CameraMonitorService;

  const path = (steamId: string) => `camera-${MATCH_ID}-${steamId}`;

  const rosterRow = (steamId: string) => ({
    match_id: MATCH_ID,
    server_id: SERVER_ID,
    steam_id: steamId,
    name: `player-${steamId}`,
    coach: false,
  });

  const coachRow = (steamId: string) => ({
    ...rosterRow(steamId),
    name: `coach-${steamId}`,
    coach: true,
  });

  beforeEach(() => {
    redis = {
      hgetall: jest.fn().mockResolvedValue({}),
      hset: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
    };
    postgres = { query: jest.fn().mockResolvedValue([rosterRow(STEAM_ID)]) };
    rconClient = { send: jest.fn().mockResolvedValue("") };
    rcon = { connect: jest.fn().mockResolvedValue(rconClient) };
    mediaMtx = { listPaths: jest.fn() };
    sockets = { broadcastToCluster: jest.fn().mockResolvedValue(undefined) };

    service = new CameraMonitorService(
      new Logger("CameraMonitorTest"),
      postgres as any,
      rcon as any,
      mediaMtx as any,
      sockets as any,
      { getConnection: () => redis } as any,
    );
  });

  const listing = (
    entries: Array<[string, { ready: boolean; bytesReceived: number }]>,
  ) => new Map(entries);

  it("does not report a camera that has only just gone down", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    mediaMtx.listPaths.mockResolvedValue(listing([]));

    await service.monitorLiveMatches(1000 + 29_000);

    expect(rcon.connect).not.toHaveBeenCalled();
  });

  it("reports a camera that has been down past the grace window", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    mediaMtx.listPaths.mockResolvedValue(listing([]));

    await service.monitorLiveMatches(1000 + 30_000);

    expect(rconClient.send).toHaveBeenCalledWith(`camera_state ${STEAM_ID}`);
  });

  // A path can stay `ready` long after the uplink dies, so bytes standing
  // still is the signal that actually matters.
  it("treats a ready path with no new bytes as offline", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    mediaMtx.listPaths.mockResolvedValue(
      listing([[path(STEAM_ID), { ready: true, bytesReceived: 500 }]]),
    );

    await service.monitorLiveMatches(1000 + 31_000);

    expect(rconClient.send).toHaveBeenCalledWith(`camera_state ${STEAM_ID}`);
  });

  it("keeps a camera healthy while bytes keep arriving", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    mediaMtx.listPaths.mockResolvedValue(
      listing([[path(STEAM_ID), { ready: true, bytesReceived: 900 }]]),
    );

    await service.monitorLiveMatches(1000 + 31_000);

    expect(rcon.connect).not.toHaveBeenCalled();
    expect(redis.hset).toHaveBeenCalledWith(`camera:samples:${MATCH_ID}`, {
      [STEAM_ID]: `900:${1000 + 31_000}:live`,
    });
  });

  // A coach has no `is_connected` to say whether they turned up, so their own
  // camera is the attendance record: watched from the moment it first appears,
  // and not before.
  describe("coaches", () => {
    const COACH = "76561198000000009";

    it("ignores a coach who has never been on camera", async () => {
      postgres.query.mockResolvedValue([coachRow(COACH)]);
      redis.hgetall.mockResolvedValue({});
      mediaMtx.listPaths.mockResolvedValue(listing([]));

      await service.monitorLiveMatches(1000 + 60_000);

      expect(rcon.connect).not.toHaveBeenCalled();
      // Nothing sampled either: an absent coach leaves no trace to age out of.
      expect(redis.hset).toHaveBeenCalledWith(`camera:samples:${MATCH_ID}`, {});
    });

    it("starts watching a coach once their camera appears", async () => {
      postgres.query.mockResolvedValue([coachRow(COACH)]);
      redis.hgetall.mockResolvedValue({});
      mediaMtx.listPaths.mockResolvedValue(
        listing([[path(COACH), { ready: true, bytesReceived: 400 }]]),
      );

      await service.monitorLiveMatches(5000);

      expect(rcon.connect).not.toHaveBeenCalled();
      expect(redis.hset).toHaveBeenCalledWith(`camera:samples:${MATCH_ID}`, {
        [COACH]: `400:5000:live`,
      });
    });

    it("pauses on a coach who was on camera and then dropped", async () => {
      postgres.query.mockResolvedValue([coachRow(COACH)]);
      redis.hgetall.mockResolvedValue({ [COACH]: "400:1000:live" });
      mediaMtx.listPaths.mockResolvedValue(listing([]));

      await service.monitorLiveMatches(1000 + 30_000);

      expect(rconClient.send).toHaveBeenCalledWith(`camera_state ${COACH}`);
    });
  });

  // Pausing every live match because our own monitor lost its connection is
  // far worse than missing a drop for one pass.
  it("changes nothing when mediamtx cannot be reached", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    mediaMtx.listPaths.mockResolvedValue(null);

    await service.monitorLiveMatches(1000 + 600_000);

    expect(rcon.connect).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it("only sends rcon when the offending set changes", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    redis.get.mockResolvedValue(STEAM_ID);
    mediaMtx.listPaths.mockResolvedValue(listing([]));

    await service.monitorLiveMatches(1000 + 60_000);

    expect(rcon.connect).not.toHaveBeenCalled();
  });

  it("clears the reported state once every camera is back", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    redis.get.mockResolvedValue(STEAM_ID);
    mediaMtx.listPaths.mockResolvedValue(
      listing([[path(STEAM_ID), { ready: true, bytesReceived: 900 }]]),
    );

    await service.monitorLiveMatches(1000 + 60_000);

    expect(rconClient.send).toHaveBeenCalledWith("camera_state ");
    expect(redis.del).toHaveBeenCalledWith(`camera:reported:${MATCH_ID}`);
  });

  it("reports offenders in a stable order so the set compares cleanly", async () => {
    postgres.query.mockResolvedValue([
      rosterRow(OTHER_STEAM_ID),
      rosterRow(STEAM_ID),
    ]);
    redis.hgetall.mockResolvedValue({
      [STEAM_ID]: "500:1000:live",
      [OTHER_STEAM_ID]: "500:1000:live",
    });
    mediaMtx.listPaths.mockResolvedValue(listing([]));

    await service.monitorLiveMatches(1000 + 60_000);

    expect(rconClient.send).toHaveBeenCalledWith(
      `camera_state ${STEAM_ID},${OTHER_STEAM_ID}`,
    );
  });

  it("does nothing when no live match requires cameras", async () => {
    postgres.query.mockResolvedValue([]);

    await service.monitorLiveMatches();

    expect(mediaMtx.listPaths).not.toHaveBeenCalled();
  });

  it("leaves the reported state alone when rcon is unreachable", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    rcon.connect.mockResolvedValue(null);
    mediaMtx.listPaths.mockResolvedValue(listing([]));

    await service.monitorLiveMatches(1000 + 60_000);

    expect(redis.setex).not.toHaveBeenCalled();
  });

  it("pushes a camera-status change to watching clients", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    mediaMtx.listPaths.mockResolvedValue(listing([]));

    await service.monitorLiveMatches(1000 + 60_000);

    expect(sockets.broadcastToCluster).toHaveBeenCalledWith("camera-status", {
      matchId: MATCH_ID,
    });
  });

  // The push is what stops a grid sitting stale for a whole poll, so it must
  // not be coupled to the game server being reachable.
  it("still pushes when rcon is unreachable", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    rcon.connect.mockResolvedValue(null);
    mediaMtx.listPaths.mockResolvedValue(listing([]));

    await service.monitorLiveMatches(1000 + 60_000);

    expect(sockets.broadcastToCluster).toHaveBeenCalledWith("camera-status", {
      matchId: MATCH_ID,
    });
  });

  // Nothing changed means nothing to say: a push per pass would have every
  // client refetching every 10s for no reason.
  it("does not push when the offending set is unchanged", async () => {
    redis.hgetall.mockResolvedValue({ [STEAM_ID]: "500:1000:live" });
    redis.get.mockResolvedValue(STEAM_ID);
    mediaMtx.listPaths.mockResolvedValue(listing([]));

    await service.monitorLiveMatches(1000 + 60_000);

    expect(sockets.broadcastToCluster).not.toHaveBeenCalled();
  });
});
