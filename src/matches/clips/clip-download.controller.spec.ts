import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash } from "crypto";
import { Readable, Writable } from "stream";
import { ClipDownloadController } from "./clip-download.controller";
import { ClipViewsController } from "./clip-views.controller";
import { ClipsService } from "./clips.service";
import { S3Service } from "../../s3/s3.service";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";

const CLIP_ID = "166d93b9-1421-48a7-a40a-cb3a7135ea21";
const FILE = "clips/76561198000000001/4d12968c-ed12-402e-a6bd-21543009f0e3.mp4";
const SIZE = 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const VIEWER_IP = "203.0.113.9";

function workerViewerKey(ip: string, userAgent: string) {
  return createHash("sha256")
    .update(`${ip}\n${userAgent}`)
    .digest("hex")
    .slice(0, 32);
}

describe("ClipDownloadController view counting", () => {
  let now: number;
  let redisKeys: Map<string, number>;
  let redis: { set: jest.Mock; del: jest.Mock };
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let s3: { stat: jest.Mock; get: jest.Mock; getPartial: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  let controller: ClipDownloadController;
  let workerBeacon: ClipViewsController;

  const increments = () =>
    hasura.mutation.mock.calls.filter(([mutation]) => {
      return mutation.update_match_clips?.__args?._inc?.views_count === 1;
    }).length;

  async function get(
    opts: {
      method?: string;
      range?: string;
      query?: Record<string, string>;
      userAgent?: string;
      ip?: string | null;
    } = {},
  ) {
    const response: any = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const headers: Record<string, unknown> = {};
    response.statusCode = 200;
    response.headersSent = false;
    response.setHeader = (name: string, value: unknown) => {
      headers[name.toLowerCase()] = value;
    };
    response.getHeader = (name: string) => headers[name.toLowerCase()];
    response.status = (code: number) => {
      response.statusCode = code;
      return response;
    };
    response.json = jest.fn(() => response);
    const finished = new Promise((resolve) => response.on("finish", resolve));

    const query = { name: "ace.mp4", v: "1", ...(opts.query ?? {}) };
    const request: any = {
      method: opts.method ?? "GET",
      ip: "10.0.0.1",
      query,
      headers: {
        "user-agent": opts.userAgent ?? CHROME,
        ...(opts.ip === null
          ? {}
          : { "cf-connecting-ip": opts.ip ?? VIEWER_IP }),
        ...(opts.range ? { range: opts.range } : {}),
      },
    };

    await controller.download(CLIP_ID, query.name, query.dl, request, response);
    if (response.statusCode === 200 || response.statusCode === 206) {
      await finished;
    }
    return response;
  }

  beforeEach(async () => {
    now = Date.parse("2026-10-12T12:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
    process.env.S3_SECRET = "worker-secret";

    redisKeys = new Map();
    redis = {
      set: jest.fn(
        async (
          key: string,
          _value: string,
          _ex: string,
          ttlSeconds: number,
          nx: string,
        ) => {
          const expiresAt = redisKeys.get(key);
          if (nx === "NX" && expiresAt !== undefined && expiresAt > now) {
            return null;
          }
          redisKeys.set(key, now + ttlSeconds * 1000);
          return "OK";
        },
      ),
      del: jest.fn(async (key: string) => {
        return redisKeys.delete(key) ? 1 : 0;
      }),
    };
    hasura = {
      query: jest.fn().mockResolvedValue({
        match_clips_by_pk: { file: FILE, thumbnail_url: null },
      }),
      mutation: jest
        .fn()
        .mockResolvedValue({ update_match_clips: { affected_rows: 1 } }),
    };
    s3 = {
      stat: jest.fn().mockResolvedValue({ size: SIZE }),
      get: jest.fn(async () => Readable.from([Buffer.alloc(SIZE)])),
      getPartial: jest.fn(
        async (_key: string, _start: number, length: number) =>
          Readable.from([Buffer.alloc(length)]),
      ),
    };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const clips = new ClipsService(
      logger as any,
      hasura as any,
      {} as any,
      s3 as any,
      {} as any,
      {} as any,
      { getConnection: () => redis } as any,
      {} as any,
      {} as any,
      { get: () => ({}) } as any,
    );

    const module = await Test.createTestingModule({
      controllers: [ClipDownloadController, ClipViewsController],
      providers: [
        { provide: S3Service, useValue: s3 },
        { provide: HasuraService, useValue: hasura },
        { provide: PostgresService, useValue: {} },
        { provide: ClipsService, useValue: clips },
        { provide: Logger, useValue: logger },
      ],
    }).compile();

    controller = module.get(ClipDownloadController);
    workerBeacon = module.get(ClipViewsController);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.S3_SECRET;
  });

  it("counts a full GET once, by the clip's stored file", async () => {
    const response = await get();

    expect(response.statusCode).toBe(200);
    expect(increments()).toBe(1);
    const args = hasura.mutation.mock.calls[0][0].update_match_clips.__args;
    expect(args.where).toEqual({ file: { _eq: FILE } });
    expect(args._inc).toEqual({ views_count: 1 });
  });

  it("does not count a second GET from the same viewer within 6 hours", async () => {
    await get();
    now += SIX_HOURS_MS - 1000;
    await get();
    await get({ range: "bytes=0-" });

    expect(increments()).toBe(1);

    await get({ ip: "198.51.100.7" });
    expect(increments()).toBe(2);

    now += 2000;
    await get();
    expect(increments()).toBe(3);
  });

  it("dedupes on the same viewer key the Worker sends, so the two paths count a viewer once", async () => {
    await workerBeacon.play("Bearer worker-secret", {
      file: FILE,
      clientKey: workerViewerKey(VIEWER_IP, CHROME),
    });
    expect(increments()).toBe(1);

    await get();
    expect(increments()).toBe(1);
    const claim = `clip-view:${FILE}:${workerViewerKey(VIEWER_IP, CHROME)}`;
    expect(redis.set.mock.calls).toEqual([
      [claim, "1", "EX", 6 * 60 * 60, "NX"],
      [claim, "1", "EX", 6 * 60 * 60, "NX"],
    ]);
  });

  it.each([
    ["bytes=0-", true],
    ["bytes=400-600", true],
    ["bytes=500-500", true],
    ["bytes=0-1", false],
    ["bytes=0-499", false],
    ["bytes=501-999", false],
    ["bytes=-200", false],
  ])(
    "counts the range %s only when it spans the file's midpoint (%s)",
    async (range, counts) => {
      const response = await get({ range });

      expect(response.statusCode).toBe(206);
      expect(increments()).toBe(counts ? 1 : 0);

      await get({ range: "bytes=0-" });
      expect(increments()).toBe(1);
    },
  );

  // The range path sets 206 and Content-Range before it fetches the bytes, so
  // a fetch that fails afterwards still carries a range spanning the midpoint.
  it.each([
    [
      "a missing file (404)",
      () => s3.stat.mockRejectedValueOnce({ code: "NotFound" }),
      {},
      404,
    ],
    [
      "an unsatisfiable range (416)",
      () => undefined,
      { range: "bytes=2000-" },
      416,
    ],
    [
      "a failed stat (500)",
      () => s3.stat.mockRejectedValueOnce(new Error("s3 unavailable")),
      {},
      500,
    ],
    [
      "a range whose fetch failed (500)",
      () => s3.getPartial.mockRejectedValueOnce(new Error("s3 unavailable")),
      { range: "bytes=0-" },
      500,
    ],
  ])(
    "does not count %s, and leaves the viewer's next play countable",
    async (_label, fail, opts, status) => {
      fail();
      const response = await get(opts);

      expect(response.statusCode).toBe(status);
      expect(increments()).toBe(0);

      await get();
      expect(increments()).toBe(1);
    },
  );

  it("keys a viewer without cf-connecting-ip by the request's own address", async () => {
    await get({ ip: null });

    expect(increments()).toBe(1);
    expect(redis.set.mock.calls[0][0]).toBe(
      `clip-view:${FILE}:${workerViewerKey("10.0.0.1", CHROME)}`,
    );

    await get({ ip: "10.0.0.1" });
    expect(increments()).toBe(1);
  });

  it.each([
    ["a HEAD request", { method: "HEAD" }],
    ["?dl=1", { query: { dl: "1" } }],
    ["?download=1", { query: { download: "1" } }],
    ["?noview=1", { query: { noview: "1" } }],
  ])(
    "does not count %s, and leaves the viewer's next play countable",
    async (_label, opts) => {
      const response = await get(opts);

      expect(response.statusCode).toBe(200);
      expect(increments()).toBe(0);

      await get();
      expect(increments()).toBe(1);
    },
  );

  it.each([
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "TelegramBot (like TwitterBot)",
  ])("does not count the bot %s", async (userAgent) => {
    await get({ userAgent });
    expect(increments()).toBe(0);

    await get();
    expect(increments()).toBe(1);
  });

  it("keeps playing when the count fails, and releases the claim so the viewer's retry counts", async () => {
    hasura.mutation.mockRejectedValueOnce(new Error("hasura unavailable"));

    const failed = await get();

    expect(failed.statusCode).toBe(200);
    expect(increments()).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).not.toContain(VIEWER_IP);

    await get();

    expect(increments()).toBe(2);
    expect(
      redisKeys.has(`clip-view:${FILE}:${workerViewerKey(VIEWER_IP, CHROME)}`),
    ).toBe(true);
  });
});
