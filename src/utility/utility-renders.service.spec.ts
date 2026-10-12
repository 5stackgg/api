import {
  UTILITY_RENDER_BULK_LIMIT,
  UTILITY_RENDER_VERSION,
  UTILITY_RENDER_VERSION_UNREPORTED,
  UtilityRendersService,
} from "./utility-renders.service";

const LINEUP = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "A main deep smoke",
  map_name: "de_mirage",
  utility_type: "Smoke",
  side: "TERRORIST",
  origin_x: 1,
  origin_y: 2,
  origin_z: 3,
  eye_z: 64,
  view_yaw: 90,
  view_pitch: -20,
  technique: "Jump",
  throw_strength: "Full",
  jump_throw_bind: true,
  land_x: 10,
  land_y: 20,
  land_z: 30,
  flight_time_ms: 2400,
  confidence: "exact",
  visibility: "Public",
  archived_at: null as Date | null,
  initial_pos_x: 1,
  initial_pos_y: 2,
  initial_pos_z: 3,
  initial_vel_x: 100,
  initial_vel_y: 0,
  initial_vel_z: 50,
  preview_file: null as string | null,
  author_steam_id: "76561198000000001",
  public_reviewed_by: "76561198000000002",
};

const APPROACH = [
  {
    t: -16,
    x: 10,
    y: 20,
    z: 30,
    vx: 250,
    vy: -12.5,
    vz: 0,
    pitch: -3.5,
    yaw: 90,
    buttons: 1024,
    on_ground: true,
    ducked: false,
  },
  {
    t: 0,
    x: 14,
    y: 20,
    z: 31.5,
    vx: 240,
    vy: 0,
    vz: 301,
    pitch: -4,
    yaw: 91.5,
    buttons: 1026,
    on_ground: false,
    ducked: true,
  },
];

// The queue's one BullMQ job id. A custom id may not contain a colon, which is
// not a validation the type system can catch -- it throws at add() time, after
// the render row is already inserted, leaving it queued with no batch.
describe("UtilityRendersService.WORKER_JOB_ID", () => {
  it("is an id BullMQ accepts", () => {
    expect(UtilityRendersService.WORKER_JOB_ID).not.toContain(":");
  });
});

describe("UtilityRendersService", () => {
  let service: UtilityRendersService;
  let postgres: { query: jest.Mock };
  let s3: {
    put: jest.Mock;
    has: jest.Mock;
    removePrefix: jest.Mock;
    remove?: jest.Mock;
  };
  let queue: { add: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    postgres = { query: jest.fn() };
    s3 = {
      put: jest.fn(),
      has: jest.fn().mockResolvedValue(false),
      removePrefix: jest.fn().mockResolvedValue(0),
    };
    queue = { add: jest.fn() };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new UtilityRendersService(
      logger as any,
      postgres as any,
      s3 as any,
      queue as any,
    );
  });

  // The wedge this exists to break: a row inserted, an add() that never landed,
  // and an in-flight unique index that then refuses every retry.
  describe("reconcileQueued", () => {
    // One job films every map, so however many maps hold queued rows there is
    // one thing to wake.
    it("wakes the queue's one job when rows are queued", async () => {
      postgres.query.mockResolvedValueOnce([
        { map_name: "de_mirage" },
        { map_name: "de_nuke" },
      ]);

      await expect(service.reconcileQueued()).resolves.toBe(2);

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        "BatchUtilityRenderJob",
        {},
        expect.objectContaining({
          jobId: UtilityRendersService.WORKER_JOB_ID,
        }),
      );
    });

    it("does nothing when no row is queued", async () => {
      postgres.query.mockResolvedValueOnce([]);

      await expect(service.reconcileQueued()).resolves.toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("reports nothing reconciled when the queue cannot be reached", async () => {
      postgres.query.mockResolvedValueOnce([{ map_name: "de_mirage" }]);
      queue.add.mockRejectedValueOnce(new Error("redis is down"));

      await expect(service.reconcileQueued()).resolves.toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // Boot ticks are the whole reason the pod can be watched: status-reporter.sh
  // broadcasts {status:"booting", boot_stage} to every job. They must land in
  // status_history and NEVER in row.status -- the CHECK constraint rejects
  // "booting", and the in-flight filter would lose the row if it did not.
  describe("reportStatus / boot ticks", () => {
    const row = (history: Array<unknown>) => [
      { status: "queued", status_history: history },
    ];

    it("records a boot tick in history without touching the row status", async () => {
      postgres.query.mockResolvedValueOnce(row([])).mockResolvedValueOnce([]);

      await service.reportStatus("render-1", {
        status: "booting",
        boot_stage: "launching_steam",
      });

      const [sql, bindings] = postgres.query.mock.calls[1];
      expect(sql).toContain("SET status_history");
      expect(sql).not.toMatch(/SET status\s*=/);
      expect(JSON.parse(bindings[1])).toEqual([
        expect.objectContaining({
          status: "booting",
          boot_stage: "launching_steam",
        }),
      ]);
    });

    it("coalesces within-stage ticks onto one entry and keeps the first at", async () => {
      const first = {
        status: "booting",
        at: "2026-01-01T00:00:00.000Z",
        boot_stage: "downloading_cs2",
      };
      postgres.query
        .mockResolvedValueOnce(row([first]))
        .mockResolvedValueOnce([]);

      await service.reportStatus("render-1", {
        status: "booting",
        boot_stage: "downloading_cs2:Validating",
        boot_progress: 0.4,
      });

      const history = JSON.parse(postgres.query.mock.calls[1][1][1]);
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(
        expect.objectContaining({
          at: first.at,
          boot_stage: "downloading_cs2:Validating",
          boot_progress: 0.4,
        }),
      );
    });

    it("pushes a fresh entry when the stage changes", async () => {
      const first = {
        status: "booting",
        at: "2026-01-01T00:00:00.000Z",
        boot_stage: "downloading_cs2",
      };
      postgres.query
        .mockResolvedValueOnce(row([first]))
        .mockResolvedValueOnce([]);

      await service.reportStatus("render-1", {
        status: "booting",
        boot_stage: "launching_steam",
      });

      const history = JSON.parse(postgres.query.mock.calls[1][1][1]);
      expect(history.map((entry: any) => entry.boot_stage)).toEqual([
        "downloading_cs2",
        "launching_steam",
      ]);
    });

    it("still writes a real status transition to the row", async () => {
      postgres.query.mockResolvedValueOnce(row([])).mockResolvedValueOnce([]);

      await service.reportStatus("render-1", {
        status: "rendering",
        progress: 0.3,
      });

      const [sql, bindings] = postgres.query.mock.calls[1];
      expect(sql).toMatch(/SET status = \$2/);
      expect(bindings[1]).toBe("rendering");
    });
  });

  // The api's own phases come before any pod exists to report them.
  describe("stampBootStage", () => {
    it("stamps the stage onto every render in the batch", async () => {
      postgres.query
        .mockResolvedValueOnce([
          { id: "r1", status_history: [] },
          { id: "r2", status_history: [] },
        ])
        .mockResolvedValue([]);

      await service.stampBootStage(["r1", "r2"], "server_starting");

      const updates = postgres.query.mock.calls.slice(1);
      expect(updates).toHaveLength(2);
      for (const [, bindings] of updates) {
        expect(JSON.parse(bindings[1])).toEqual([
          expect.objectContaining({
            status: "booting",
            boot_stage: "server_starting",
          }),
        ]);
      }
    });
  });

  describe("enqueue", () => {
    it("queues a public lineup and wakes the queue", async () => {
      postgres.query
        .mockResolvedValueOnce([LINEUP])
        .mockResolvedValueOnce([{ id: "render-1", status: "queued" }]);

      const result = await service.enqueue(LINEUP.id);

      expect(result).toEqual({
        queued: true,
        render_id: "render-1",
        status: "queued",
        reason: null,
      });
      const [, bindings] = postgres.query.mock.calls[1];
      expect(bindings[5]).toBe("queued");
      expect(bindings[6]).toBeNull();
      expect(queue.add).toHaveBeenCalledWith(
        "BatchUtilityRenderJob",
        {},
        expect.objectContaining({
          jobId: UtilityRendersService.WORKER_JOB_ID,
        }),
      );
    });

    it("drops the lineup's earlier cancelled and failed attempts when a new one is queued", async () => {
      postgres.query
        .mockResolvedValueOnce([LINEUP])
        .mockResolvedValueOnce([{ id: "render-2", status: "queued" }]);

      await service.enqueue(LINEUP.id, { force: true });

      const sweep = postgres.query.mock.calls.find(([sql]) =>
        /DELETE FROM public\.utility_lineup_renders/.test(String(sql)),
      );
      expect(sweep).toBeDefined();
      expect(sweep[1]).toEqual([
        LINEUP.id,
        "render-2",
        ["queued", "rendering", "uploading", "done"],
      ]);
    });

    it("sweeps the files of the attempts a new one replaces", async () => {
      postgres.query
        .mockResolvedValueOnce([LINEUP])
        .mockResolvedValueOnce([{ id: "render-2", status: "queued" }])
        .mockResolvedValueOnce([{ id: "render-1" }]);

      await service.enqueue(LINEUP.id, { force: true });

      expect(s3.removePrefix).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/render-1`,
      );
    });

    it("reads the run-up off the lineup into the stored spec", async () => {
      postgres.query
        .mockResolvedValueOnce([{ ...LINEUP, approach: APPROACH }])
        .mockResolvedValueOnce([{ id: "render-3", status: "queued" }]);

      await service.enqueue(LINEUP.id);

      expect(postgres.query.mock.calls[0][0]).toMatch(/l\.approach/);
      const [, bindings] = postgres.query.mock.calls[1];
      expect(JSON.parse(bindings[4]).approach).toEqual(APPROACH);
    });

    it("refuses a lineup that is not public", async () => {
      postgres.query.mockResolvedValueOnce([
        { ...LINEUP, visibility: "Private" },
      ]);

      const result = await service.enqueue(LINEUP.id);

      expect(result.queued).toBe(false);
      expect(result.reason).toMatch(/public, unarchived/);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("leaves an already-rendered lineup alone unless forced", async () => {
      postgres.query.mockResolvedValueOnce([
        { ...LINEUP, preview_file: "clips/utility/x.mp4" },
      ]);

      const result = await service.enqueue(LINEUP.id);

      expect(result.queued).toBe(false);
      expect(result.reason).toMatch(/already has a preview/);
      expect(postgres.query).toHaveBeenCalledTimes(1);
    });

    it("re-renders an already-rendered lineup when forced", async () => {
      postgres.query
        .mockResolvedValueOnce([
          { ...LINEUP, preview_file: "clips/utility/x.mp4" },
        ])
        .mockResolvedValueOnce([{ id: "render-2", status: "queued" }]);

      const result = await service.enqueue(LINEUP.id, { force: true });

      expect(result.queued).toBe(true);
      expect(queue.add).toHaveBeenCalled();
    });

    it("does not double-queue when the in-flight index refuses the insert", async () => {
      postgres.query.mockResolvedValueOnce([LINEUP]).mockResolvedValueOnce([]);

      const result = await service.enqueue(LINEUP.id);

      expect(result.queued).toBe(false);
      expect(result.reason).toMatch(/already in flight/);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("records a seedless lineup as skipped instead of booking a GPU", async () => {
      postgres.query
        .mockResolvedValueOnce([{ ...LINEUP, initial_vel_x: null }])
        .mockResolvedValueOnce([{ id: "render-3", status: "skipped" }]);

      const result = await service.enqueue(LINEUP.id);

      expect(result.queued).toBe(false);
      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/physics seed/);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("skips a lineup whose confidence is not exact", async () => {
      postgres.query
        .mockResolvedValueOnce([{ ...LINEUP, confidence: "derived" }])
        .mockResolvedValueOnce([{ id: "render-4", status: "skipped" }]);

      const result = await service.enqueue(LINEUP.id);

      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/'derived'/);
    });

    it("films a nameless lineup — the pod stages it by id", async () => {
      postgres.query
        .mockResolvedValueOnce([{ ...LINEUP, name: "  " }])
        .mockResolvedValueOnce([{ id: "render-5", status: "queued" }]);

      const result = await service.enqueue(LINEUP.id);

      expect(result.queued).toBe(true);
      expect(postgres.query.mock.calls[1][1][5]).toBe("queued");
    });

    it("hosts the practice session on the reviewer, falling back to the author", async () => {
      postgres.query
        .mockResolvedValueOnce([{ ...LINEUP, public_reviewed_by: null }])
        .mockResolvedValueOnce([{ id: "render-6", status: "queued" }]);

      await service.enqueue(LINEUP.id);

      expect(postgres.query.mock.calls[1][1][1]).toBe(LINEUP.author_steam_id);
    });
  });

  describe("buildSpec", () => {
    it("emits the field names the render pod reads", () => {
      const spec = UtilityRendersService.buildSpec(LINEUP as any);

      expect(spec).toMatchObject({
        lineup_id: LINEUP.id,
        lineup_name: LINEUP.name,
        map_name: "de_mirage",
        nade_type: "Smoke",
        side: "TERRORIST",
        has_seed: true,
        confidence: "exact",
        output: { resolution: "1080p", fps: 60 },
      });
    });

    it("tells the pod how to act the throw out and where it lands", () => {
      const spec = UtilityRendersService.buildSpec(LINEUP as any);

      expect(spec).toMatchObject({
        technique: "Jump",
        throw_strength: "Full",
        jump_throw_bind: true,
        land_x: 10,
        land_y: 20,
        land_z: 30,
      });
    });

    it("hands the pod the run-up to act out", () => {
      const spec = UtilityRendersService.buildSpec({
        ...LINEUP,
        approach: APPROACH,
      } as any);

      expect(spec.approach).toEqual(APPROACH);
      expect(JSON.parse(JSON.stringify(spec)).approach).toEqual(APPROACH);
    });

    it("says a throw made standing still has no run-up", () => {
      expect(
        UtilityRendersService.buildSpec({ ...LINEUP, approach: null } as any)
          .approach,
      ).toBeNull();
      expect(
        UtilityRendersService.buildSpec({ ...LINEUP, approach: [] } as any)
          .approach,
      ).toBeNull();
      expect(
        UtilityRendersService.buildSpec(LINEUP as any).approach,
      ).toBeNull();
    });

    it("calls a zero-velocity seed no seed at all", () => {
      const spec = UtilityRendersService.buildSpec({
        ...LINEUP,
        initial_vel_x: 0,
        initial_vel_y: 0,
        initial_vel_z: 0,
      } as any);

      expect(spec.has_seed).toBe(false);
    });
  });

  describe("validateRenderAuth", () => {
    it("accepts the pod's own token", async () => {
      postgres.query.mockResolvedValueOnce([
        {
          id: LINEUP.id,
          utility_lineup_id: LINEUP.id,
          session_token: "s3cret",
        },
      ]);

      const session = await service.validateRenderAuth(
        LINEUP.id,
        `${LINEUP.id}:s3cret`,
      );

      expect(session).toEqual({
        id: LINEUP.id,
        utility_lineup_id: LINEUP.id,
      });
    });

    it("rejects a token for a different job id", async () => {
      const session = await service.validateRenderAuth(
        LINEUP.id,
        "22222222-2222-2222-2222-222222222222:s3cret",
      );

      expect(session).toBeNull();
      expect(postgres.query).not.toHaveBeenCalled();
    });

    it("rejects a mismatched token", async () => {
      postgres.query.mockResolvedValueOnce([
        {
          id: LINEUP.id,
          utility_lineup_id: LINEUP.id,
          session_token: "s3cret",
        },
      ]);

      expect(
        await service.validateRenderAuth(LINEUP.id, `${LINEUP.id}:nope`),
      ).toBeNull();
    });

    it("rejects a job id that is not a uuid before it touches the database", async () => {
      expect(
        await service.validateRenderAuth("not-a-uuid", "not-a-uuid:s3cret"),
      ).toBeNull();
      expect(postgres.query).not.toHaveBeenCalled();
    });
  });

  describe("reportStatus", () => {
    it("appends to status_history and frees the node on a terminal status", async () => {
      postgres.query
        .mockResolvedValueOnce([{ status: "rendering", status_history: [] }])
        .mockResolvedValueOnce([]);

      await service.reportStatus("job-1", {
        status: "done",
        progress: 1,
        duration_ms: 5200,
      });

      const bindings = postgres.query.mock.calls[1][1];
      expect(bindings[1]).toBe("done");
      expect(JSON.parse(bindings[2])).toHaveLength(1);
      expect(bindings[3]).toBe(1);
      expect(bindings[6]).toBe(5200);
      expect(bindings[7]).toBe(true);
    });

    it("keeps skip_reason apart from error", async () => {
      postgres.query
        .mockResolvedValueOnce([{ status: "rendering", status_history: [] }])
        .mockResolvedValueOnce([]);

      await service.reportStatus("job-1", {
        status: "skipped",
        skip_reason: "lineup has no recorded physics seed",
        error: "lineup has no recorded physics seed",
      });

      const bindings = postgres.query.mock.calls[1][1];
      expect(bindings[5]).toBe("lineup has no recorded physics seed");
      expect(JSON.parse(bindings[2])[0].skip_reason).toBe(
        "lineup has no recorded physics seed",
      );
    });

    it("ignores an out-of-range progress rather than violating the check", async () => {
      postgres.query
        .mockResolvedValueOnce([{ status: "rendering", status_history: [] }])
        .mockResolvedValueOnce([]);

      await service.reportStatus("job-1", { status: "rendering", progress: 7 });

      expect(postgres.query.mock.calls[1][1][3]).toBeNull();
    });

    it("does nothing when the row is gone", async () => {
      postgres.query.mockResolvedValueOnce([]);

      await service.reportStatus("job-1", { status: "done" });

      expect(postgres.query).toHaveBeenCalledTimes(1);
    });

    it("never puts a cancelled render back in flight", async () => {
      postgres.query.mockResolvedValueOnce([
        { status: "cancelled", status_history: [] },
      ]);

      await service.reportStatus("job-1", {
        status: "rendering",
        progress: 0.7,
      });

      expect(postgres.query).toHaveBeenCalledTimes(1);
    });
  });

  describe("stampBootStage", () => {
    const waiting = { status: "booting", at: "t0", boot_stage: "waiting_turn" };

    // The pod asks what is next between every two lineups; a long queue
    // re-stamped each time is a write per row per lineup.
    it("does not rewrite a row that already sits in a stage said once", async () => {
      postgres.query.mockResolvedValueOnce([
        { id: "render-1", status_history: [waiting] },
        { id: "render-2", status_history: [] },
      ]);

      await service.stampBootStage(
        ["render-1", "render-2"],
        "waiting_turn",
        null,
        { once: true },
      );

      const updated = postgres.query.mock.calls
        .slice(1)
        .map(([, bindings]) => bindings[0]);
      expect(updated).toEqual(["render-2"]);
    });

    it("keeps ticking a stage that is passed through", async () => {
      postgres.query.mockResolvedValueOnce([
        { id: "render-1", status_history: [waiting] },
      ]);

      await service.stampBootStage(["render-1"], "waiting_turn");

      expect(postgres.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("what the library is missing", () => {
    const SEED = {
      confidence: "exact",
      initial_pos_x: 1,
      initial_pos_y: 2,
      initial_pos_z: 3,
      initial_vel_x: 100,
      initial_vel_y: 0,
      initial_vel_z: 50,
    };
    const row = (overrides: Record<string, unknown>) => ({
      id: "lineup",
      name: "A lineup",
      map_name: "de_mirage",
      utility_type: "Smoke",
      preview_file: "clips/utility/lineup/render.mp4",
      preview_version: UTILITY_RENDER_VERSION,
      in_flight: false,
      map_available: true,
      ...SEED,
      ...overrides,
    });
    const ROWS = [
      row({ id: "current" }),
      row({ id: "missing", preview_file: null, preview_version: null }),
      row({ id: "older", preview_version: UTILITY_RENDER_VERSION - 1 }),
      row({ id: "unversioned", preview_version: null }),
      row({ id: "unreported", preview_version: UTILITY_RENDER_VERSION_UNREPORTED }),
      row({ id: "rendering", preview_file: null, in_flight: true }),
      row({
        id: "no-seed",
        preview_file: null,
        preview_version: null,
        initial_vel_x: null,
      }),
      row({
        id: "map-gone",
        preview_file: null,
        preview_version: null,
        map_available: false,
      }),
      row({ id: "guessed-but-filmed", confidence: "estimated" }),
    ];

    // The two reads a coverage makes, whichever order it makes them in.
    const database = (
      rows: Array<unknown>,
      pipelineVersion: number | null = null,
    ) =>
      postgres.query.mockImplementation(async (sql: string) =>
        String(sql).includes("FROM public.utility_lineups l")
          ? rows
          : pipelineVersion === null
            ? []
            : [{ render_version: pipelineVersion }],
      );

    it("calls a preview outdated when an older version, or none, filmed it", () => {
      expect(UtilityRendersService.isOutdated(null)).toBe(true);
      expect(
        UtilityRendersService.isOutdated(UTILITY_RENDER_VERSION_UNREPORTED),
      ).toBe(true);
      expect(UtilityRendersService.isOutdated(UTILITY_RENDER_VERSION - 1)).toBe(
        true,
      );
      expect(UtilityRendersService.isOutdated(UTILITY_RENDER_VERSION)).toBe(
        false,
      );
      expect(UtilityRendersService.isOutdated(UTILITY_RENDER_VERSION + 1)).toBe(
        false,
      );
    });

    it("sorts every public lineup into what its preview needs", async () => {
      database(ROWS, UTILITY_RENDER_VERSION);

      const coverage = await service.coverage();

      expect(coverage).toMatchObject({
        version: UTILITY_RENDER_VERSION,
        pipeline_version: UTILITY_RENDER_VERSION,
        total: 9,
        current: 2,
        missing: 1,
        outdated: 3,
        queued: 1,
        unrenderable: 2,
      });
      expect(
        coverage.lineups.map((gap) => [gap.id, gap.state, gap.preview_version]),
      ).toEqual([
        ["missing", "missing", null],
        ["older", "outdated", UTILITY_RENDER_VERSION - 1],
        ["unversioned", "outdated", null],
        ["unreported", "outdated", UTILITY_RENDER_VERSION_UNREPORTED],
        ["no-seed", "unrenderable", null],
        ["map-gone", "unrenderable", null],
      ]);
      expect(coverage.lineups[4].reason).toContain("no recorded physics seed");
      expect(coverage.lineups[5].reason).toContain("not available for practice");
    });

    it("knows nothing about the pipeline until something has been filmed since", async () => {
      database(ROWS);

      expect((await service.coverage()).pipeline_version).toBeNull();
    });

    it("looks only at public, unarchived lineups, on one map when asked", async () => {
      database([]);

      await service.coverage("de_inferno");

      const [sql, bindings] = postgres.query.mock.calls.find(([text]) =>
        String(text).includes("FROM public.utility_lineups l"),
      );
      expect(sql).toContain("l.visibility = 'Public'");
      expect(sql).toContain("l.archived_at IS NULL");
      expect(bindings[0]).toBe("de_inferno");
    });

    describe("queueing what it is missing", () => {
      let enqueue: jest.SpyInstance;

      beforeEach(() => {
        database(ROWS, UTILITY_RENDER_VERSION);
        enqueue = jest.spyOn(service, "enqueue").mockResolvedValue({
          queued: true,
          render_id: "render",
          status: "queued",
          reason: null,
        });
      });

      const queuedIds = () => enqueue.mock.calls.map(([id]) => id);

      it("queues only the lineups with no preview", async () => {
        await expect(
          service.enqueueGaps("missing", { requestedBySteamId: "1" }),
        ).resolves.toEqual({ queued: 1, skipped: 0 });

        expect(queuedIds()).toEqual(["missing"]);
      });

      it("queues only the previews an older version filmed", async () => {
        await service.enqueueGaps("outdated", { requestedBySteamId: "1" });

        expect(queuedIds()).toEqual(["older", "unversioned", "unreported"]);
        // An outdated lineup already has a preview, which is what a plain
        // enqueue refuses on.
        expect(enqueue).toHaveBeenCalledWith("older", {
          requestedBySteamId: "1",
          force: true,
        });
      });

      // Never the current ones, never one already rendering, and never a
      // throw or a map the pod could only refuse.
      it("queues both and nothing else for all", async () => {
        await service.enqueueGaps("all", { requestedBySteamId: "1" });

        expect(queuedIds()).toEqual([
          "missing",
          "older",
          "unversioned",
          "unreported",
        ]);
      });

      it("counts what the queue turned down", async () => {
        enqueue.mockResolvedValueOnce({
          queued: false,
          render_id: null,
          status: "refused",
          reason: "a render for this lineup is already in flight",
        });

        await expect(
          service.enqueueGaps("all", { requestedBySteamId: "1" }),
        ).resolves.toEqual({ queued: 3, skipped: 1 });
      });

      // A synchronous action with a request timeout: it takes a bite and says
      // how much it left.
      it("takes a bounded bite of a long list and reports the rest", async () => {
        const many = Array.from(
          { length: UTILITY_RENDER_BULK_LIMIT + 5 },
          (_, index) =>
            row({ id: `m-${index}`, preview_file: null, preview_version: null }),
        );
        database(many, UTILITY_RENDER_VERSION);

        await expect(
          service.enqueueGaps("missing", { requestedBySteamId: "1" }),
        ).resolves.toEqual({ queued: UTILITY_RENDER_BULK_LIMIT, skipped: 5 });
      });

      // The images are behind the api, or pinned to older ones. Every preview
      // the pod films comes back outdated again, so "re-render outdated" would
      // film the whole library on every press and change nothing.
      describe("when the pod in use films an older version than the api expects", () => {
        beforeEach(() => {
          database(ROWS, UTILITY_RENDER_VERSION_UNREPORTED);
        });

        it("refuses to re-render the outdated ones", async () => {
          await expect(
            service.enqueueGaps("outdated", { requestedBySteamId: "1" }),
          ).rejects.toThrow(/older than version/);
          expect(enqueue).not.toHaveBeenCalled();
        });

        it("still films the ones with no preview at all", async () => {
          await service.enqueueGaps("all", { requestedBySteamId: "1" });

          expect(queuedIds()).toEqual(["missing"]);
        });
      });
    });
  });

  describe("finalizeUpload", () => {
    const uploading = () =>
      postgres.query
        .mockResolvedValueOnce([
          { utility_lineup_id: LINEUP.id, status: "uploading" },
        ])
        .mockResolvedValueOnce([{ preview_stills: null }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
    const lineupUpdate = () =>
      postgres.query.mock.calls.find(([sql]) =>
        String(sql).includes("UPDATE public.utility_lineups"),
      )[1];

    it("streams to S3 and only then repoints the lineup", async () => {
      uploading();
      s3.has.mockImplementation(
        async (key: string) => key === `clips/utility/${LINEUP.id}/job-1.jpg`,
      );

      const stream = {} as any;
      const result = await service.finalizeUpload("job-1", stream, 4200);

      expect(s3.put).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/job-1.mp4`,
        stream,
        "video/mp4",
      );
      expect(result.file).toBe(`clips/utility/${LINEUP.id}/job-1.mp4`);
      const updateBindings = lineupUpdate();
      expect(updateBindings[1]).toBe(`clips/utility/${LINEUP.id}/job-1.mp4`);
      expect(updateBindings[2]).toBe(`clips/utility/${LINEUP.id}/job-1.jpg`);
      expect(updateBindings[3]).toBe(4200);
    });

    // The version is what the director said it filmed with; the render queue
    // page calls a preview outdated by comparing it against the api's own.
    it("records the render version the pod reported on the lineup and the row", async () => {
      uploading();

      await service.finalizeUpload("job-1", {} as any, 4200, 2);

      expect(lineupUpdate()[5]).toBe(2);
      const rowUpdate = postgres.query.mock.calls.find(([sql]) =>
        String(sql).includes("render_version = $3::int"),
      );
      expect(rowUpdate[1]).toEqual(["job-1", 4200, 2]);
    });

    // Keeping the old preview's version would call a clip from an old pod
    // current. Not NULL either, which is a preview from before any pod said:
    // this one says the pod in use is behind.
    it("records a preview whose pod did not report a version as unreported", async () => {
      uploading();

      await service.finalizeUpload("job-1", {} as any, 4200);

      const [sql, bindings] = postgres.query.mock.calls.find(([text]) =>
        String(text).includes("UPDATE public.utility_lineups"),
      );
      expect(sql).toContain("preview_version = $6::int");
      expect(sql).not.toMatch(/COALESCE\(\$6/);
      expect(bindings[5]).toBe(UTILITY_RENDER_VERSION_UNREPORTED);
      expect(UtilityRendersService.isOutdated(bindings[5])).toBe(true);
    });

    it("never serves a re-render from the previous render's cached key", async () => {
      postgres.query
        .mockResolvedValueOnce([
          { utility_lineup_id: LINEUP.id, status: "uploading" },
        ])
        .mockResolvedValueOnce([
          {
            preview_file: `clips/utility/${LINEUP.id}.mp4`,
            preview_thumbnail: `clips/utility/${LINEUP.id}.jpg`,
            preview_stills: null,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      s3.remove = jest.fn();

      const result = await service.finalizeUpload("job-2", {} as any, null);

      expect(result.file).not.toBe(`clips/utility/${LINEUP.id}.mp4`);
      expect(s3.remove).toHaveBeenCalledWith(`clips/utility/${LINEUP.id}.mp4`);
      expect(s3.remove).toHaveBeenCalledWith(`clips/utility/${LINEUP.id}.jpg`);
    });

    it("leaves the thumbnail alone when the pod never uploaded one", async () => {
      uploading();

      await service.finalizeUpload("job-1", {} as any, null);

      expect(lineupUpdate()[2]).toBeNull();
    });

    it("records the stills this render uploaded alongside its clip", async () => {
      uploading();
      s3.has.mockImplementation(async (key: string) =>
        [
          `clips/utility/${LINEUP.id}/job-1/stance.jpg`,
          `clips/utility/${LINEUP.id}/job-1/landing.jpg`,
        ].includes(key),
      );

      await service.finalizeUpload("job-1", {} as any, null);

      expect(JSON.parse(lineupUpdate()[4])).toEqual({
        stance: `clips/utility/${LINEUP.id}/job-1/stance.jpg`,
        landing: `clips/utility/${LINEUP.id}/job-1/landing.jpg`,
      });
    });

    it("records a webp still over a jpeg one of the same kind", async () => {
      uploading();
      s3.has.mockImplementation(async (key: string) =>
        [
          `clips/utility/${LINEUP.id}/job-1/aim_close.webp`,
          `clips/utility/${LINEUP.id}/job-1/aim_close.jpg`,
          `clips/utility/${LINEUP.id}/job-1/landing.jpg`,
        ].includes(key),
      );

      await service.finalizeUpload("job-1", {} as any, null);

      expect(JSON.parse(lineupUpdate()[4])).toEqual({
        aim_close: `clips/utility/${LINEUP.id}/job-1/aim_close.webp`,
        landing: `clips/utility/${LINEUP.id}/job-1/landing.jpg`,
      });
    });

    it("retires the lineup's older finished renders once the new one is up", async () => {
      uploading();

      await service.finalizeUpload("job-1", {} as any, null);

      const retire = postgres.query.mock.calls.find(([sql]) =>
        /DELETE FROM public\.utility_lineup_renders/.test(String(sql)),
      );
      expect(retire).toBeDefined();
      expect(String(retire[0])).toMatch(/id <> \$2::uuid/);
      expect(String(retire[0])).toMatch(
        /NOT \(status = ANY\(\$3::text\[\]\)\)/,
      );
      expect(retire[1]).toEqual([
        LINEUP.id,
        "job-1",
        ["queued", "rendering", "uploading"],
      ]);
    });

    it("sweeps the files of the renders it retires", async () => {
      uploading().mockResolvedValueOnce([{ id: "job-0" }, { id: "job-x" }]);

      await service.finalizeUpload("job-1", {} as any, null);

      expect(s3.removePrefix).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/job-0`,
      );
      expect(s3.removePrefix).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/job-x`,
      );
      expect(s3.removePrefix).not.toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/job-1`,
      );
    });

    it("never pairs a new clip with an older render's stills", async () => {
      postgres.query
        .mockResolvedValueOnce([
          { utility_lineup_id: LINEUP.id, status: "uploading" },
        ])
        .mockResolvedValueOnce([
          {
            preview_stills: {
              aim: `clips/utility/${LINEUP.id}/job-0/aim.jpg`,
            },
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      s3.remove = jest.fn();

      await service.finalizeUpload("job-1", {} as any, null);

      expect(lineupUpdate()[4]).toBeNull();
      expect(s3.remove).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/job-0/aim.jpg`,
      );
    });

    it("refuses to overwrite a finished render", async () => {
      postgres.query.mockResolvedValueOnce([
        { utility_lineup_id: LINEUP.id, status: "done" },
      ]);

      await expect(
        service.finalizeUpload("job-1", {} as any, null),
      ).rejects.toThrow("render is done");
      expect(s3.put).not.toHaveBeenCalled();
    });
  });

  describe("deletePreview", () => {
    const current = `clips/utility/${LINEUP.id}/render-new.mp4`;

    it("takes the preview with the render whose clip it is, whatever else is done", async () => {
      postgres.query
        .mockResolvedValueOnce([
          {
            utility_lineup_id: LINEUP.id,
            status: "done",
            preview_file: current,
          },
        ])
        .mockResolvedValueOnce([
          {
            preview_file: current,
            preview_thumbnail: `clips/utility/${LINEUP.id}/render-new.jpg`,
            preview_stills: {
              aim: `clips/utility/${LINEUP.id}/render-new/aim.webp`,
            },
          },
        ])
        .mockResolvedValueOnce([{ id: "render-new" }]);
      s3.remove = jest.fn();

      await expect(service.deletePreview("render-new")).resolves.toBe(true);

      expect(
        postgres.query.mock.calls.some(([sql]) =>
          String(sql).includes("UPDATE public.utility_lineups"),
        ),
      ).toBe(true);
      expect(s3.remove).toHaveBeenCalledWith(current);
      expect(s3.remove).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/render-new/aim.webp`,
      );
    });

    it("leaves the preview alone when an older render is deleted", async () => {
      postgres.query
        .mockResolvedValueOnce([
          {
            utility_lineup_id: LINEUP.id,
            status: "done",
            preview_file: current,
          },
        ])
        .mockResolvedValueOnce([{ id: "render-old" }]);
      s3.remove = jest.fn();

      await expect(service.deletePreview("render-old")).resolves.toBe(true);

      expect(
        postgres.query.mock.calls.some(([sql]) =>
          String(sql).includes("UPDATE public.utility_lineups"),
        ),
      ).toBe(false);
      expect(s3.remove).not.toHaveBeenCalled();
    });

    it("takes the preview with a render deleted before it reported done", async () => {
      postgres.query
        .mockResolvedValueOnce([
          {
            utility_lineup_id: LINEUP.id,
            status: "uploading",
            preview_file: current,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            preview_file: current,
            preview_thumbnail: null,
            preview_stills: null,
          },
        ])
        .mockResolvedValueOnce([{ id: "render-new" }]);
      s3.remove = jest.fn();

      await service.deletePreview("render-new");

      expect(
        postgres.query.mock.calls.some(([sql]) =>
          String(sql).includes("UPDATE public.utility_lineups"),
        ),
      ).toBe(true);
    });

    it("sweeps the files of whichever render is deleted", async () => {
      postgres.query
        .mockResolvedValueOnce([
          {
            utility_lineup_id: LINEUP.id,
            status: "error",
            preview_file: current,
          },
        ])
        .mockResolvedValueOnce([{ id: "render-old" }]);

      await service.deletePreview("render-old");

      expect(s3.removePrefix).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/render-old`,
      );
    });

    it("keeps a preview from before per-render keys with its only done render", async () => {
      postgres.query
        .mockResolvedValueOnce([
          {
            utility_lineup_id: LINEUP.id,
            status: "done",
            preview_file: `clips/utility/${LINEUP.id}.mp4`,
          },
        ])
        .mockResolvedValueOnce([{ count: "1" }])
        .mockResolvedValueOnce([{ id: "render-old" }]);
      s3.remove = jest.fn();

      await service.deletePreview("render-old");

      expect(s3.remove).not.toHaveBeenCalled();
    });
  });

  describe("clearFinished", () => {
    it("sweeps cleared renders' files but never the live preview's", async () => {
      postgres.query
        .mockResolvedValueOnce([
          { id: "render-live", utility_lineup_id: LINEUP.id },
          { id: "render-failed", utility_lineup_id: LINEUP.id },
        ])
        .mockResolvedValueOnce([
          {
            id: LINEUP.id,
            preview_file: `clips/utility/${LINEUP.id}/render-live.mp4`,
          },
        ]);

      await expect(service.clearFinished()).resolves.toBe(2);

      expect(s3.removePrefix).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/render-failed`,
      );
      expect(s3.removePrefix).not.toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/render-live`,
      );
    });
  });

  describe("uploadStill", () => {
    it("stores a still under the lineup's clip prefix", async () => {
      postgres.query.mockResolvedValueOnce([
        { utility_lineup_id: LINEUP.id, status: "rendering" },
      ]);

      const stream = {} as any;
      const result = await service.uploadStill("job-1", "aim_close", stream);

      expect(s3.put).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/job-1/aim_close.jpg`,
        stream,
        "image/jpeg",
      );
      expect(result.key).toBe(`clips/utility/${LINEUP.id}/job-1/aim_close.jpg`);
    });

    it("stores a webp still as webp", async () => {
      postgres.query.mockResolvedValueOnce([
        { utility_lineup_id: LINEUP.id, status: "rendering" },
      ]);

      const stream = {} as any;
      const result = await service.uploadStill(
        "job-1",
        "aim_close",
        stream,
        "image/webp",
      );

      expect(s3.put).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/job-1/aim_close.webp`,
        stream,
        "image/webp",
      );
      expect(result.key).toBe(
        `clips/utility/${LINEUP.id}/job-1/aim_close.webp`,
      );
    });

    it("stores anything that is not webp as jpeg", async () => {
      postgres.query.mockResolvedValueOnce([
        { utility_lineup_id: LINEUP.id, status: "rendering" },
      ]);

      await service.uploadStill("job-1", "aim", {} as any, "text/html");

      expect(s3.put).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}/job-1/aim.jpg`,
        expect.anything(),
        "image/jpeg",
      );
    });

    it("refuses a still for a cancelled render", async () => {
      postgres.query.mockResolvedValueOnce([
        { utility_lineup_id: LINEUP.id, status: "cancelled" },
      ]);

      await expect(
        service.uploadStill("job-1", "aim", {} as any),
      ).rejects.toThrow("render is cancelled");
      expect(s3.put).not.toHaveBeenCalled();
    });

    it("only knows the stills the director films", () => {
      expect(UtilityRendersService.isStill("landing")).toBe(true);
      expect(UtilityRendersService.isStill("stance_eyes")).toBe(true);
      expect(UtilityRendersService.isStill("aim_pin")).toBe(true);
      expect(UtilityRendersService.isStill("../../etc")).toBe(false);
    });
  });

  describe("s3 keys", () => {
    it("keys each render apart, under the worker's clips/ prefix", () => {
      expect(UtilityRendersService.GetPreviewS3Key("abc", "r1")).toBe(
        "clips/utility/abc/r1.mp4",
      );
      expect(UtilityRendersService.GetPreviewThumbnailS3Key("abc", "r1")).toBe(
        "clips/utility/abc/r1.jpg",
      );
      expect(UtilityRendersService.GetPreviewS3Key("abc", "r2")).not.toBe(
        UtilityRendersService.GetPreviewS3Key("abc", "r1"),
      );
    });
  });
});
