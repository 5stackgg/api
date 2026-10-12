import { UtilityArtifactsService } from "./utility-artifacts.service";
import { UtilityRendersService } from "./utility-renders.service";

const LINEUP = "11111111-1111-1111-1111-111111111111";

const CAPTURE = {
  log: "AAECAwQ=",
  samples: [[3, 100]] as Array<[number, number]>,
  detonation: { x: -500, y: -600, z: 128 },
  tick_rate: 64,
};

const ROW = {
  gid: 7,
  round: 3,
  start_tick: 100,
  end_tick: 1500,
  ox: -640,
  oy: -720,
  oz: 96,
  vs: 16,
  dx: 12,
  dy: 10,
  dz: 6,
  arr: "/////w==",
};

describe("UtilityArtifactsService smoke voxels", () => {
  let service: UtilityArtifactsService;
  let postgres: { query: jest.Mock };
  let s3: { put: jest.Mock; remove: jest.Mock; removePrefix: jest.Mock };
  let parser: { smokeVoxels: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    postgres = {
      query: jest.fn().mockResolvedValue([{ smoke_voxels_file: null }]),
    };
    s3 = {
      put: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(true),
      removePrefix: jest.fn().mockResolvedValue(0),
    };
    parser = { smokeVoxels: jest.fn().mockResolvedValue(ROW) };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new UtilityArtifactsService(
      logger as any,
      s3 as any,
      postgres as any,
      parser as any,
    );
  });

  // The worker that serves the preview clip routes clips/ and nothing else.
  it("keys the smoke under clips/, beside the lineup's preview", () => {
    const key = UtilityArtifactsService.smokeVoxelsKey(LINEUP, 1700000000000);

    expect(key).toBe(`clips/utility/${LINEUP}.smoke.1700000000000.json`);
  });

  // removePreview's sweep is the smoke's cleanup on delete.
  it("puts the smoke where deleting the lineup sweeps", async () => {
    await service.removePreview(LINEUP);

    const [prefix] = s3.removePrefix.mock.calls[0];
    expect(prefix).toBe(UtilityRendersService.GetLineupPreviewS3Prefix(LINEUP));
    expect(
      UtilityArtifactsService.smokeVoxelsKey(LINEUP, Date.now()).startsWith(
        prefix,
      ),
    ).toBe(true);
  });

  it("stores the parser's row and the log it came from as json and points the lineup at it", async () => {
    await expect(service.storeSmokeVoxels(LINEUP, CAPTURE)).resolves.toBe(true);

    expect(parser.smokeVoxels).toHaveBeenCalledWith(CAPTURE);

    const [key, body, contentType] = s3.put.mock.calls[0];
    expect(key).toMatch(
      new RegExp(`^clips/utility/${LINEUP}\\.smoke\\.\\d+\\.json$`),
    );
    expect(JSON.parse(body.toString())).toEqual({ ...ROW, capture: CAPTURE });
    expect(contentType).toBe("application/json");

    const [sql, bindings] = postgres.query.mock.calls[0];
    expect(sql).toContain("smoke_voxels_file = $2");
    expect(sql).toContain("smoke_voxels_at = now()");
    expect(bindings).toEqual([LINEUP, key]);
    expect(s3.remove).not.toHaveBeenCalled();
  });

  it("removes the smoke it replaced", async () => {
    postgres.query.mockResolvedValueOnce([
      { smoke_voxels_file: `clips/utility/${LINEUP}.smoke.1.json` },
    ]);

    await service.storeSmokeVoxels(LINEUP, CAPTURE);

    expect(s3.remove).toHaveBeenCalledWith(
      `clips/utility/${LINEUP}.smoke.1.json`,
    );
  });

  it("stores nothing when the parser rebuilt nothing", async () => {
    parser.smokeVoxels.mockResolvedValueOnce(null);

    await expect(service.storeSmokeVoxels(LINEUP, CAPTURE)).resolves.toBe(
      false,
    );
    expect(s3.put).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  // A demo already carries the row, so nothing is asked of the parser.
  it("stores a row it is handed without the parser", async () => {
    await expect(service.storeSmokeVoxelRow(LINEUP, ROW)).resolves.toBe(true);

    expect(parser.smokeVoxels).not.toHaveBeenCalled();
    expect(JSON.parse(s3.put.mock.calls[0][1].toString())).toEqual(ROW);
    expect(postgres.query.mock.calls[0][1]).toEqual([
      LINEUP,
      s3.put.mock.calls[0][0],
    ]);
  });

  it("answers false rather than throwing when the upload fails", async () => {
    s3.put.mockRejectedValueOnce(new Error("bucket down"));

    await expect(service.storeSmokeVoxelRow(LINEUP, ROW)).resolves.toBe(false);
    expect(postgres.query).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[utility-smoke-voxels]"),
    );
  });

  it("takes its upload back when the lineup went before it landed", async () => {
    postgres.query.mockResolvedValueOnce([]);

    await expect(service.storeSmokeVoxelRow(LINEUP, ROW)).resolves.toBe(false);
    expect(s3.remove).toHaveBeenCalledWith(s3.put.mock.calls[0][0]);
  });
});
