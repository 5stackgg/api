import { UtilityRendersService } from "./utility-renders.service";

const LINEUP = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "A main deep smoke",
  map_name: "de_mirage",
  utility_type: "Smoke",
  side: "TERRORIST",
  origin_x: 1, origin_y: 2, origin_z: 3,
  eye_z: 64,
  view_yaw: 90, view_pitch: -20,
  flight_time_ms: 2400,
  confidence: "exact",
  visibility: "Public",
  archived_at: null as Date | null,
  initial_pos_x: 1, initial_pos_y: 2, initial_pos_z: 3,
  initial_vel_x: 100, initial_vel_y: 0, initial_vel_z: 50,
  preview_file: null as string | null,
  author_steam_id: "76561198000000001",
  public_reviewed_by: "76561198000000002",
};

describe("UtilityRendersService", () => {
  let service: UtilityRendersService;
  let postgres: { query: jest.Mock };
  let s3: { put: jest.Mock; has: jest.Mock };
  let queue: { add: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    postgres = { query: jest.fn() };
    s3 = { put: jest.fn(), has: jest.fn().mockResolvedValue(false) };
    queue = { add: jest.fn() };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new UtilityRendersService(
      logger as any,
      postgres as any,
      s3 as any,
      queue as any,
    );
  });

  describe("enqueue", () => {
    it("queues a public lineup and dispatches its map", async () => {
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
        { mapName: "de_mirage" },
        expect.objectContaining({
          jobId: "utility-render-batch:de_mirage",
        }),
      );
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
      postgres.query
        .mockResolvedValueOnce([LINEUP])
        .mockResolvedValueOnce([]);

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

    it("skips a nameless lineup — the plugin resolves by name only", async () => {
      postgres.query
        .mockResolvedValueOnce([{ ...LINEUP, name: "  " }])
        .mockResolvedValueOnce([{ id: "render-5", status: "skipped" }]);

      const result = await service.enqueue(LINEUP.id);

      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/no name/);
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
  });

  describe("finalizeUpload", () => {
    it("streams to S3 and only then repoints the lineup", async () => {
      postgres.query
        .mockResolvedValueOnce([
          { utility_lineup_id: LINEUP.id, status: "uploading" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      s3.has.mockResolvedValueOnce(true);

      const stream = {} as any;
      const result = await service.finalizeUpload("job-1", stream, 4200);

      expect(s3.put).toHaveBeenCalledWith(
        `clips/utility/${LINEUP.id}.mp4`,
        stream,
        "video/mp4",
      );
      expect(result.file).toBe(`clips/utility/${LINEUP.id}.mp4`);
      const updateBindings = postgres.query.mock.calls[1][1];
      expect(updateBindings[1]).toBe(`clips/utility/${LINEUP.id}.mp4`);
      expect(updateBindings[2]).toBe(`clips/utility/${LINEUP.id}.jpg`);
      expect(updateBindings[3]).toBe(4200);
    });

    it("leaves the thumbnail alone when the pod never uploaded one", async () => {
      postgres.query
        .mockResolvedValueOnce([
          { utility_lineup_id: LINEUP.id, status: "uploading" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.finalizeUpload("job-1", {} as any, null);

      expect(postgres.query.mock.calls[1][1][2]).toBeNull();
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

  describe("s3 keys", () => {
    it("keys on the lineup so a re-render replaces the clip in place", () => {
      expect(UtilityRendersService.GetPreviewS3Key("abc")).toBe(
        "clips/utility/abc.mp4",
      );
      expect(UtilityRendersService.GetPreviewThumbnailS3Key("abc")).toBe(
        "clips/utility/abc.jpg",
      );
    });
  });
});
