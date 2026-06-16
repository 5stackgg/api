jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { ClipsService } from "./clips.service";

describe("ClipsService", () => {
  let service: ClipsService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let gameStreamer: { killBatchHighlightsPod: jest.Mock };
  let batchQueue: { getJobs: jest.Mock; add: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    hasura = { query: jest.fn(), mutation: jest.fn() };
    gameStreamer = { killBatchHighlightsPod: jest.fn() };
    batchQueue = { getJobs: jest.fn().mockResolvedValue([]), add: jest.fn() };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new ClipsService(
      logger as any,
      hasura as any,
      {} as any,
      {} as any,
      gameStreamer as any,
      { release: jest.fn() } as any,
      { getConnection: jest.fn() } as any,
      batchQueue as any,
    );
  });

  describe("pauseClipRenderBatch", () => {
    it("resets in-flight rows to queued+paused with node cleared", async () => {
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs: [{ match_map_demo_id: "demo-1" }],
      });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 3 },
      });

      const paused = await service.pauseClipRenderBatch("map-1");

      expect(paused).toBe(3);
      const updateArgs =
        hasura.mutation.mock.calls[0][0].update_clip_render_jobs.__args;
      expect(updateArgs._set).toEqual({
        paused: true,
        status: "queued",
        game_server_node_id: null,
      });
      expect(updateArgs.where.match_map_id._eq).toBe("map-1");
      expect(updateArgs.where.game_server_node_id).toBeUndefined();
    });

    it("scopes the UPDATE to game_server_node_id when nodeId is passed", async () => {
      hasura.query.mockResolvedValueOnce({ clip_render_jobs: [] });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 1 },
      });

      await service.pauseClipRenderBatch("map-1", "node-A");

      const updateWhere =
        hasura.mutation.mock.calls[0][0].update_clip_render_jobs.__args.where;
      expect(updateWhere.game_server_node_id).toEqual({ _eq: "node-A" });
    });

    it("kills the batch pod for each affected demo", async () => {
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs: [
          { match_map_demo_id: "demo-1" },
          { match_map_demo_id: "demo-2" },
        ],
      });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 5 },
      });

      await service.pauseClipRenderBatch("map-1");

      expect(gameStreamer.killBatchHighlightsPod).toHaveBeenCalledTimes(2);
      expect(gameStreamer.killBatchHighlightsPod).toHaveBeenCalledWith(
        "map-1",
        "demo-1",
      );
      expect(gameStreamer.killBatchHighlightsPod).toHaveBeenCalledWith(
        "map-1",
        "demo-2",
      );
    });

    it("removes BullMQ entries matching the matchMapId", async () => {
      hasura.query.mockResolvedValueOnce({ clip_render_jobs: [] });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 0 },
      });
      const removeA = jest.fn();
      const removeB = jest.fn();
      batchQueue.getJobs.mockResolvedValueOnce([
        { data: { matchMapId: "map-1" }, remove: removeA },
        { data: { matchMapId: "other" }, remove: removeB },
      ]);

      await service.pauseClipRenderBatch("map-1");

      expect(removeA).toHaveBeenCalled();
      expect(removeB).not.toHaveBeenCalled();
    });
  });

  describe("isRenderResumeLocked", () => {
    it("locks when any active game-streamer row exists", async () => {
      hasura.query.mockResolvedValueOnce({ match_streams: [{ id: "s1" }] });

      await expect(service.isRenderResumeLocked()).resolves.toBe(true);
    });

    it("unlocked when no streamer rows and toggle is off", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: { value: "false" } });

      await expect(service.isRenderResumeLocked()).resolves.toBe(false);
    });

    it("unlocked when toggle setting row is missing", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: null });

      await expect(service.isRenderResumeLocked()).resolves.toBe(false);
    });

    it("locks when toggle is on and a Live match has a GPU-server", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: { value: "true" } })
        .mockResolvedValueOnce({ matches: [{ id: "m1" }] });

      await expect(service.isRenderResumeLocked()).resolves.toBe(true);
    });

    it("unlocked when toggle is on but no Live GPU-server match", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: { value: "true" } })
        .mockResolvedValueOnce({ matches: [] });

      await expect(service.isRenderResumeLocked()).resolves.toBe(false);
    });
  });

  describe("resumeClipRenderBatch", () => {
    it("no-ops when the lock is held", async () => {
      hasura.query.mockResolvedValueOnce({ match_streams: [{ id: "s1" }] });

      const cleared = await service.resumeClipRenderBatch("map-1");

      expect(cleared).toBe(0);
      expect(hasura.mutation).not.toHaveBeenCalled();
    });

    it("clears paused and re-enqueues BullMQ per demo when unlocked", async () => {
      hasura.query
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({ settings_by_pk: { value: "false" } });
      hasura.mutation.mockResolvedValueOnce({
        update_clip_render_jobs: { affected_rows: 4 },
      });
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs: [
          { match_map_demo_id: "demo-1" },
          { match_map_demo_id: "demo-2" },
        ],
      });

      const cleared = await service.resumeClipRenderBatch("map-1");

      expect(cleared).toBe(4);
      expect(batchQueue.add).toHaveBeenCalledTimes(2);
    });
  });
});
