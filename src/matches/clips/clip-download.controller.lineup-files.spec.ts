import { INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Readable } from "stream";
import request from "supertest";
import { ClipDownloadController } from "./clip-download.controller";
import { ClipsService } from "./clips.service";
import { S3Service } from "../../s3/s3.service";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";

const LINEUP = "ffe58c95-4581-4320-a14e-f2efb95ccebe";
const RENDER = "560035c5-ea95-41f4-bcb9-6f0d5985be94";
const CLIP = `clips/utility/${LINEUP}/${RENDER}.mp4`;
const MATCH_CLIP_ID = "166d93b9-1421-48a7-a40a-cb3a7135ea21";
const MATCH_CLIP = "clips/76561198000000001/match-clip.mp4";
const MATCH_CLIP_THUMBNAIL = "clips/76561198000000001/match-clip.jpg";
const SIZE = 1000;
// Valid as the recorded smoke's JSON, which the HTTP client parses.
const BODY = Buffer.from("{}".padEnd(SIZE));

// Without a Cloudflare worker a lineup's files are fetched from the demos
// domain, where the path is the object's key. Asked over HTTP, because which
// route a path lands on is the thing under test.
describe("ClipDownloadController lineup files", () => {
  let app: INestApplication;
  let viewer: { steam_id: string; role: string } | undefined;
  let roleNow: string;
  let postgres: { query: jest.Mock };
  let s3: { stat: jest.Mock; get: jest.Mock; getPartial: jest.Mock };

  const get = (key: string) => request(app.getHttpServer()).get(`/${key}`);

  beforeEach(async () => {
    viewer = undefined;
    roleNow = "user";
    postgres = { query: jest.fn().mockResolvedValue([{ public: true }]) };
    s3 = {
      stat: jest.fn().mockResolvedValue({ size: SIZE }),
      get: jest.fn(async () => Readable.from([BODY])),
      getPartial: jest.fn(
        async (_key: string, _start: number, length: number) =>
          Readable.from([Buffer.alloc(length)]),
      ),
    };

    const module = await Test.createTestingModule({
      controllers: [ClipDownloadController],
      providers: [
        { provide: S3Service, useValue: s3 },
        {
          provide: HasuraService,
          useValue: {
            query: jest.fn().mockResolvedValue({
              match_clips_by_pk: {
                file: MATCH_CLIP,
                thumbnail_url: MATCH_CLIP_THUMBNAIL,
                visibility: "public",
              },
            }),
            getHasuraHeaders: jest.fn(async (steamId: string) => ({
              "x-hasura-role": roleNow,
              "x-hasura-user-id": steamId,
            })),
          },
        },
        { provide: PostgresService, useValue: postgres },
        {
          provide: ClipsService,
          useValue: { registerStreamedClipView: jest.fn() },
        },
        {
          provide: Logger,
          useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    // What passport does with the session cookie.
    app.use((request: any, _response: any, next: () => void) => {
      request.user = viewer;
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("plays the preview a lineup points at, by its key", async () => {
    const response = await get(CLIP).query({ v: "1760356807" });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["content-length"]).toBe(String(SIZE));
    expect(postgres.query.mock.calls[0][1]).toEqual([LINEUP, CLIP, "{}"]);
    expect(s3.get).toHaveBeenCalledWith(CLIP);
  });

  it.each([
    [`clips/utility/${LINEUP}/${RENDER}.jpg`, "image/jpeg"],
    [`clips/utility/${LINEUP}/${RENDER}/aim_close.webp`, "image/webp"],
    [`clips/utility/${LINEUP}/${RENDER}/landing.jpg`, "image/jpeg"],
    [`clips/utility/${LINEUP}.smoke.1700000000000.json`, "application/json"],
    [`clips/utility/${LINEUP}.mp4`, "video/mp4"],
  ])("serves %s as %s", async (key, contentType) => {
    const response = await get(key);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(contentType);
    expect(postgres.query.mock.calls[0][1]).toEqual([LINEUP, key, "{}"]);
    expect(s3.stat).toHaveBeenCalledWith(key);
  });

  it("answers a range, which Safari requires before it plays a video", async () => {
    const response = await get(CLIP).set("Range", "bytes=100-199");

    expect(response.status).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 100-199/${SIZE}`);
    expect(s3.getPartial).toHaveBeenCalledWith(CLIP, 100, 100);
  });

  it("answers the HEAD the share menu reads the clip's size from", async () => {
    const response = await request(app.getHttpServer()).head(`/${CLIP}`);

    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe(String(SIZE));
  });

  it("downloads under the name the share menu asks for", async () => {
    const response = await get(CLIP).query({
      dl: "1",
      name: "inferno-a-site.mp4",
    });

    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="inferno-a-site.mp4"',
    );
  });

  // The session keeps the role its owner signed in with for as long as it
  // lives, so a moderator demoted since would still open every lineup.
  it("asks as the role the signed-in viewer holds now, not the session's", async () => {
    viewer = { steam_id: "76561198000000001", role: "moderator" };
    roleNow = "user";

    await get(CLIP);

    expect(JSON.parse(postgres.query.mock.calls[0][1][2])).toEqual({
      "x-hasura-role": "user",
      "x-hasura-user-id": "76561198000000001",
    });
  });

  // Signing out, or being dropped from the lineup's team, has to take the
  // file away, so the browser asks again each time.
  it("does not let the browser keep a file served because of who asked", async () => {
    viewer = { steam_id: "76561198000000001", role: "user" };
    postgres.query.mockResolvedValueOnce([{ public: false }]);

    const response = await get(CLIP);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "private, max-age=0, must-revalidate",
    );
  });

  // A public lineup's key never holds anything else, so the visitor's own
  // browser may keep it. A cache shared between visitors may not: it would go
  // on serving a lineup that has since stopped being public, and would hand
  // one visitor's download name to the rest wherever it drops the query string.
  it.each([
    {},
    { dl: "1" },
    { name: "invoice.exe" },
    { dl: "1", name: "a.mp4" },
  ])(
    "lets only the visitor's own browser keep the answer to %j",
    async (query) => {
      const response = await get(CLIP).query(query);

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe(
        "private, max-age=2592000, immutable",
      );
    },
  );

  it.each([
    [
      "a failed fetch (500)",
      () => s3.get.mockRejectedValueOnce(new Error("s3 unavailable")),
      CLIP,
      500,
    ],
    [
      "a file S3 no longer has (404)",
      () => s3.stat.mockRejectedValueOnce({ code: "NotFound" }),
      CLIP,
      404,
    ],
    [
      "a file no lineup points at (404)",
      () => postgres.query.mockResolvedValueOnce([]),
      `clips/utility/${LINEUP}/11111111-1111-1111-1111-111111111111.mp4`,
      404,
    ],
  ])(
    "does not let %s be cached as the file",
    async (_label, fail, key, status) => {
      fail();

      const response = await get(key);

      expect(response.status).toBe(status);
      expect(response.headers["cache-control"]).toBe("no-store");
    },
  );

  it("answers 404 without reading S3 for a file no visible lineup points at", async () => {
    postgres.query.mockResolvedValueOnce([]);

    const response = await get(
      `clips/utility/${LINEUP}/11111111-1111-1111-1111-111111111111.mp4`,
    );

    expect(response.status).toBe(404);
    expect(s3.stat).not.toHaveBeenCalled();
  });

  it.each([
    `clips/utility/not-a-lineup/${RENDER}.mp4`,
    `clips/utility/${LINEUP}/${RENDER}.exe`,
    `clips/utility/${LINEUP}x/${RENDER}.mp4`,
    `clips/utility/${LINEUP}/%2e%2e/%2e%2e/secret.mp4`,
  ])("answers 404 for %s without reading S3", async (key) => {
    postgres.query.mockResolvedValue([]);

    const response = await get(key);

    expect(response.status).toBe(404);
    expect(s3.stat).not.toHaveBeenCalled();
  });

  it("still plays a match clip and its thumbnail by the clip's id", async () => {
    const clip = await get(`clips/${MATCH_CLIP_ID}`);
    const thumbnail = await get(`clips/${MATCH_CLIP_ID}/thumbnail`);

    expect(clip.status).toBe(200);
    expect(clip.headers["cache-control"]).toBe(
      "private, max-age=0, must-revalidate",
    );
    expect(thumbnail.status).toBe(200);
    expect(s3.stat.mock.calls.map(([key]) => key)).toEqual([
      MATCH_CLIP,
      MATCH_CLIP_THUMBNAIL,
    ]);
    expect(postgres.query).not.toHaveBeenCalled();
  });
});
