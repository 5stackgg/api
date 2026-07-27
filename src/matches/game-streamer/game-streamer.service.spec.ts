jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { GameStreamerService } from "./game-streamer.service";

describe("GameStreamerService", () => {
  let service: GameStreamerService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  const config = {
    get: (key: string) =>
      key === "gameServers" ? { namespace: "test" } : ({} as any),
  };

  beforeEach(() => {
    hasura = { query: jest.fn(), mutation: jest.fn() };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new GameStreamerService(
      logger as any,
      config as any,
      hasura as any,
      {} as any,
      { getConnection: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  const setOf = () =>
    hasura.mutation.mock.calls[0][0].update_match_demo_sessions_by_pk.__args
      ._set;

  describe("reportDemoStatus", () => {
    it("moves the row for a normal status report", async () => {
      hasura.query.mockResolvedValueOnce({
        match_demo_sessions_by_pk: {
          status: "downloading_cs2",
          status_history: [{ status: "downloading_cs2", at: "2026-01-01" }],
        },
      });
      hasura.mutation.mockResolvedValueOnce({});

      await service.reportDemoStatus("session-1", { status: "launching_cs2" });

      const set = setOf();
      expect(set.status).toBe("launching_cs2");
      expect(set.last_status_at).toBe("now()");
      expect(set.status_history).toHaveLength(2);
      expect((set.status_history as any[])[1].status).toBe("launching_cs2");
    });

    it("leaves the row status alone for an event, appending to history", async () => {
      hasura.query.mockResolvedValueOnce({
        match_demo_sessions_by_pk: {
          status: "downloading_cs2",
          status_history: [{ status: "downloading_cs2", at: "2026-01-01" }],
        },
      });
      hasura.mutation.mockResolvedValueOnce({});

      await service.reportDemoStatus("session-1", {
        status: "demo_ready",
        event: "1",
      });

      const set = setOf();
      expect(set.status).toBeUndefined();
      expect(set.error_message).toBeUndefined();
      expect(set.last_status_at).toBe("now()");
      expect((set.status_history as any[]).map((e: any) => e.status)).toEqual([
        "downloading_cs2",
        "demo_ready",
      ]);
    });

    it("treats event=0 as a normal status report", async () => {
      hasura.query.mockResolvedValueOnce({
        match_demo_sessions_by_pk: { status: "booting", status_history: [] },
      });
      hasura.mutation.mockResolvedValueOnce({});

      await service.reportDemoStatus("session-1", {
        status: "launching_cs2",
        event: "0",
      });

      expect(setOf().status).toBe("launching_cs2");
    });

    it("appends after an event instead of rewriting it", async () => {
      // The row still says downloading_cs2 while the newest history entry is
      // the demo_ready event — coalescing must compare against the entry.
      hasura.query.mockResolvedValueOnce({
        match_demo_sessions_by_pk: {
          status: "downloading_cs2",
          status_history: [
            { status: "downloading_cs2", at: "2026-01-01T00:00:00.000Z" },
            { status: "demo_ready", at: "2026-01-01T00:01:00.000Z" },
          ],
        },
      });
      hasura.mutation.mockResolvedValueOnce({});

      await service.reportDemoStatus("session-1", {
        status: "downloading_cs2",
        progress: "42",
      });

      const history = setOf().status_history as any[];
      expect(history.map((e) => e.status)).toEqual([
        "downloading_cs2",
        "demo_ready",
        "downloading_cs2",
      ]);
      expect(history[2].progress).toBe(42);
    });

    it("coalesces repeat progress ticks into the last entry", async () => {
      hasura.query.mockResolvedValueOnce({
        match_demo_sessions_by_pk: {
          status: "downloading_cs2",
          status_history: [
            {
              status: "downloading_cs2",
              at: "2026-01-01T00:00:00.000Z",
              progress: 10,
            },
          ],
        },
      });
      hasura.mutation.mockResolvedValueOnce({});

      await service.reportDemoStatus("session-1", {
        status: "downloading_cs2",
        progress: "55",
      });

      const history = setOf().status_history as any[];
      expect(history).toHaveLength(1);
      expect(history[0].progress).toBe(55);
      // `at` stays the stage start so elapsed doesn't reset every tick.
      expect(history[0].at).toBe("2026-01-01T00:00:00.000Z");
    });

    it("clamps an oversized status before it reaches the row or history", async () => {
      hasura.query.mockResolvedValueOnce({
        match_demo_sessions_by_pk: { status: "booting", status_history: [] },
      });
      hasura.mutation.mockResolvedValueOnce({});

      await service.reportDemoStatus("session-1", { status: "x".repeat(500) });

      const set = setOf();
      expect(set.status).toHaveLength(64);
      expect((set.status_history as any[])[0].status).toHaveLength(64);
    });

    it("no-ops when the session row is gone", async () => {
      hasura.query.mockResolvedValueOnce({ match_demo_sessions_by_pk: null });

      await service.reportDemoStatus("session-1", { status: "live" });

      expect(hasura.mutation).not.toHaveBeenCalled();
    });
  });

  describe("reportStatus", () => {
    const streamSetOf = () =>
      hasura.mutation.mock.calls[0][0].update_match_streams.__args._set;

    beforeEach(() => {
      hasura.mutation.mockResolvedValue({
        update_match_streams: { affected_rows: 1 },
      });
    });

    it("keeps stream_url and is_live intact for an event", async () => {
      hasura.query.mockResolvedValueOnce({
        match_streams: [{ status: "live", status_history: [] }],
      });

      await service.reportStatus("match-1", {
        status: "demo_ready",
        event: "1",
      });

      const set = streamSetOf();
      expect(set.status).toBeUndefined();
      expect(set.is_live).toBeUndefined();
      expect(set.stream_url).toBeUndefined();
      expect((set.status_history as any[])[0].status).toBe("demo_ready");
    });

    it("still takes a stream_url an event carries", async () => {
      hasura.query.mockResolvedValueOnce({
        match_streams: [{ status: "booting", status_history: [] }],
      });

      await service.reportStatus("match-1", {
        status: "demo_ready",
        event: "1",
        stream_url: "srt://host?streamid=publish:match-1",
      });

      expect(streamSetOf().stream_url).toBe(
        "srt://host?streamid=publish:match-1",
      );
    });

    it("clears stream_url on a normal report that omits it", async () => {
      hasura.query.mockResolvedValueOnce({
        match_streams: [{ status: "booting", status_history: [] }],
      });

      await service.reportStatus("match-1", { status: "launching_cs2" });

      const set = streamSetOf();
      expect(set.status).toBe("launching_cs2");
      expect(set.stream_url).toBeNull();
      expect(set.is_live).toBe(false);
    });
  });
});
