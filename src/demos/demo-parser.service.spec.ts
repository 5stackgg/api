import { DemoParserService } from "./demo-parser.service";

const CAPTURE = {
  log: "AAECAwQ=",
  samples: [
    [3, 100],
    [5, 102],
  ] as Array<[number, number]>,
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

describe("DemoParserService.smokeVoxels", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let parser: DemoParserService;

  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    );

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    parser = new DemoParserService(
      logger as any,
      { get: () => ({ demoParserUrl: "http://parser" }) } as any,
      {} as any,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts the plugin's capture as is and answers the parser's row", async () => {
    answer(200, ROW);

    await expect(parser.smokeVoxels(CAPTURE)).resolves.toEqual(ROW);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://parser/smoke-voxels");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(CAPTURE);
  });

  // Only the four fields the parser's contract names cross, whatever else the
  // caller's object happens to carry.
  it("sends nothing past the capture", async () => {
    answer(200, ROW);

    await parser.smokeVoxels({ ...CAPTURE, render: true } as any);

    expect(
      Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body)).sort(),
    ).toEqual(["detonation", "log", "samples", "tick_rate"]);
  });

  it("answers null for a log with nothing in it to rebuild", async () => {
    answer(422, "no voxels in the log");

    await expect(parser.smokeVoxels(CAPTURE)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[smoke-voxels] 422"),
    );
  });

  it("answers null when the parser cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(parser.smokeVoxels(CAPTURE)).resolves.toBeNull();
  });

  it("answers null for a grid with no cells", async () => {
    answer(200, { ...ROW, dz: 0 });

    await expect(parser.smokeVoxels(CAPTURE)).resolves.toBeNull();
  });
});
