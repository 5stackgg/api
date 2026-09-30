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
  let gameStreamer: {
    killBatchHighlightsPod: jest.Mock;
    resolveClipOutput: jest.Mock;
  };
  let batchQueue: { getJobs: jest.Mock; add: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    hasura = { query: jest.fn(), mutation: jest.fn() };
    gameStreamer = {
      killBatchHighlightsPod: jest.fn(),
      resolveClipOutput: jest.fn(),
    };
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
      { notifyPlayers: jest.fn() } as any,
    );
  });

  describe("auto highlight output", () => {
    it("renders at the operator's fps and resolution", async () => {
      gameStreamer.resolveClipOutput.mockResolvedValue({
        resolution: "720p",
        fps: 30,
      });
      const buildPresetSpec = jest
        .spyOn(service, "buildPresetSpec")
        .mockResolvedValue({
          match_map_id: "map-1",
          segments: [{ start_tick: 100, end_tick: 400 }],
          output: { format: "mp4", resolution: "720p", fps: 30 },
          destination: "library",
          title: "Best Round",
        });

      await (service as any).buildAutoClipSpecForTarget(
        "map-1",
        "76561198000000009",
        "demo-1",
        [{ tick: 200, weapon: "ak47" }],
        [{ start_tick: 0, end_tick: 500 }],
        { minKills: 1, alwaysKnife: false },
        { defaultVisibility: "private" },
      );

      expect(buildPresetSpec.mock.calls[0][3]).toEqual({
        resolution: "720p",
        fps: 30,
      });
    });
  });

  describe("auto highlight kill count", () => {
    const rounds = [
      { start_tick: 0, freeze_end_tick: 100, end_tick: 2000 },
      { start_tick: 3000, freeze_end_tick: 3100, end_tick: 6000 },
    ];
    const roundKills = [1000, 1100, 1200, 1300].map((tick) => ({
      tick,
      weapon: "ak47",
    }));
    const laterKnife = { tick: 5000, weapon: "knife_karambit" };

    function mockPresetSpecs() {
      gameStreamer.resolveClipOutput.mockResolvedValue({
        resolution: "1080p",
        fps: 60,
      });
      jest
        .spyOn(service, "buildPresetSpec")
        .mockImplementation(async (_mapId, _sid, preset) =>
          preset === "best_round"
            ? {
                match_map_id: "map-1",
                segments: [
                  { start_tick: 808, end_tick: 1428, kill_tick: 1300 },
                ],
                output: { format: "mp4", resolution: "1080p", fps: 60 },
                destination: "library",
                title: "Player — Best Round (4K)",
                round: 1,
                kills_count: 4,
              }
            : {
                match_map_id: "map-1",
                segments: [
                  { start_tick: 4808, end_tick: 5128, kill_tick: 5000 },
                ],
                output: { format: "mp4", resolution: "1080p", fps: 60 },
                destination: "library",
                title: "Player — 1 Knife Kill",
                round: 2,
                kills_count: 1,
              },
        );
    }

    it("counts only the best round's kills when a knife kill from another round is appended", async () => {
      mockPresetSpecs();

      const spec = await (service as any).buildAutoClipSpecForTarget(
        "map-1",
        "76561198000000009",
        "demo-1",
        [...roundKills, laterKnife],
        rounds,
        { minKills: 3, alwaysKnife: true },
        { defaultVisibility: "private" },
      );

      expect(spec.segments).toHaveLength(2);
      expect(spec.title).toBe("Player — Best Round (4K) + 1 Knife Kill");
      expect(spec.kills_count).toBe(4);
    });

    it("stores the spec's kill count instead of every kill in the footage", async () => {
      hasura.query.mockResolvedValueOnce({
        match_map_demos: [
          {
            kills: [...roundKills, laterKnife].map((k) => ({
              ...k,
              killer: "76561198000000009",
              victim: "76561198000000001",
            })),
          },
        ],
      });

      const count = await (service as any).countKillsForSpec(
        "map-1",
        {
          match_map_id: "map-1",
          segments: [
            { start_tick: 808, end_tick: 1428 },
            { start_tick: 4808, end_tick: 5128 },
          ],
          output: { format: "mp4", resolution: "1080p", fps: 60 },
          destination: "library",
          kills_count: 4,
        },
        "76561198000000009",
      );

      expect(count).toBe(4);
    });

    it("still counts the footage for specs without a kill count", async () => {
      hasura.query.mockResolvedValueOnce({
        match_map_demos: [
          {
            kills: [...roundKills, laterKnife].map((k) => ({
              ...k,
              killer: "76561198000000009",
              victim: "76561198000000001",
            })),
          },
        ],
      });

      const count = await (service as any).countKillsForSpec(
        "map-1",
        {
          match_map_id: "map-1",
          segments: [
            { start_tick: 808, end_tick: 1428 },
            { start_tick: 4808, end_tick: 5128 },
          ],
          output: { format: "mp4", resolution: "1080p", fps: 60 },
          destination: "library",
        },
        "76561198000000009",
      );

      expect(count).toBe(5);
    });
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
  describe("reportClipRenderStatus", () => {
    const setOf = () =>
      hasura.mutation.mock.calls[0][0].update_clip_render_jobs_by_pk.__args
        ._set;

    beforeEach(() => {
      hasura.mutation.mockResolvedValue({
        update_clip_render_jobs_by_pk: { id: "job-1" },
      });
    });

    it("moves the row for a real status", async () => {
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs_by_pk: { status: "queued", status_history: [] },
      });

      await service.reportClipRenderStatus("job-1", {
        status: "rendering",
        progress: 0.5,
      });

      const set = setOf();
      expect(set.status).toBe("rendering");
      expect(set.progress).toBe(0.5);
    });

    it("keeps the row queued for a boot tick", async () => {
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs_by_pk: { status: "queued", status_history: [] },
      });

      await service.reportClipRenderStatus("job-1", {
        status: "booting",
        boot_stage: "downloading_cs2:Verifying",
        boot_progress: 0.42,
      });

      const set = setOf();
      expect(set.status).toBeUndefined();
      const history = set.status_history as any[];
      expect(history[0].status).toBe("booting");
      expect(history[0].boot_stage).toBe("downloading_cs2:Verifying");
      expect(history[0].boot_progress).toBe(0.42);
    });

    it("files an event as a boot stage instead of an off-enum status", async () => {
      // clip_render_jobs_status_chk only allows the six pipeline statuses, so
      // a raw `demo_ready` in `status` would fail the mutation outright.
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs_by_pk: { status: "queued", status_history: [] },
      });

      await service.reportClipRenderStatus("job-1", {
        status: "demo_ready",
        event: "1",
      });

      const set = setOf();
      expect(set.status).toBeUndefined();
      const history = set.status_history as any[];
      expect(history[0].status).toBe("booting");
      expect(history[0].boot_stage).toBe("demo_ready");
    });

    it("ignores event=0", async () => {
      hasura.query.mockResolvedValueOnce({
        clip_render_jobs_by_pk: { status: "queued", status_history: [] },
      });

      await service.reportClipRenderStatus("job-1", {
        status: "rendering",
        event: "0",
      });

      expect(setOf().status).toBe("rendering");
    });
  });
});
