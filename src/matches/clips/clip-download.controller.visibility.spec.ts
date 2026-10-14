import { INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Readable } from "stream";
import request from "supertest";
import { ClipDownloadController } from "./clip-download.controller";
import { ClipsService } from "./clips.service";
import { S3Service } from "../../s3/s3.service";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";

const CLIP_ID = "166d93b9-1421-48a7-a40a-cb3a7135ea21";
const FILE = "clips/76561198000000001/match-clip.mp4";
const THUMBNAIL = "clips/76561198000000001/match-clip.jpg";
const OWNER = "76561198000000001";
const STRANGER = "76561198000000002";
const SIZE = 1000;

type Visibility = "private" | "match" | "public";

// The clip's files are served by its id on DEMOS_DOMAIN, where Discord and
// Slack unfurl a share and a signed-in viewer's <video> sends the session
// cookie. Each must get exactly what the clips UI would show them.
describe("ClipDownloadController clip visibility", () => {
  let app: INestApplication;
  let viewer: { steam_id: string; role: string } | undefined;
  let visibility: Visibility;
  let hasura: { query: jest.Mock; getHasuraHeaders: jest.Mock };
  let s3: { stat: jest.Mock; get: jest.Mock; getPartial: jest.Mock };

  const clip = () => ({
    file: FILE,
    thumbnail_url: THUMBNAIL,
    visibility,
  });

  // What Hasura's match_clips select permission answers: the admin secret
  // alone sees every clip, a signed-in player only their own and public ones.
  const hasuraAnswer = async (_selection: unknown, steamId?: string) => {
    if (steamId === undefined) {
      return { match_clips_by_pk: clip() };
    }
    const visible = steamId === OWNER || visibility === "public";
    return { match_clips_by_pk: visible ? clip() : null };
  };

  const get = (path: string) => request(app.getHttpServer()).get(path);

  beforeEach(async () => {
    viewer = undefined;
    visibility = "public";
    hasura = {
      query: jest.fn(hasuraAnswer),
      getHasuraHeaders: jest.fn(),
    };
    s3 = {
      stat: jest.fn().mockResolvedValue({ size: SIZE }),
      get: jest.fn(async () => Readable.from([Buffer.alloc(SIZE)])),
      getPartial: jest.fn(
        async (_key: string, _start: number, length: number) =>
          Readable.from([Buffer.alloc(length)]),
      ),
    };

    const module = await Test.createTestingModule({
      controllers: [ClipDownloadController],
      providers: [
        { provide: S3Service, useValue: s3 },
        { provide: HasuraService, useValue: hasura },
        { provide: PostgresService, useValue: { query: jest.fn() } },
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
    app.use((request: any, _response: any, next: () => void) => {
      request.user = viewer;
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each<Visibility>(["private", "match"])(
    "answers 404 to an anonymous request for a %s clip, without reading S3",
    async (hidden) => {
      visibility = hidden;

      const video = await get(`/clips/${CLIP_ID}`);
      const thumbnail = await get(`/clips/${CLIP_ID}/thumbnail`);

      expect(video.status).toBe(404);
      expect(thumbnail.status).toBe(404);
      expect(s3.stat).not.toHaveBeenCalled();
    },
  );

  it("still serves a public clip and its thumbnail to an unfurl bot", async () => {
    const video = await get(`/clips/${CLIP_ID}`).set(
      "user-agent",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    );
    const thumbnail = await get(`/clips/${CLIP_ID}/thumbnail`);

    expect(video.status).toBe(200);
    expect(thumbnail.status).toBe(200);
    expect(s3.stat.mock.calls.map(([key]) => key)).toEqual([FILE, THUMBNAIL]);
  });

  it("asks Hasura as the signed-in viewer, and answers 404 when it hides the clip", async () => {
    visibility = "private";
    viewer = { steam_id: STRANGER, role: "user" };

    const video = await get(`/clips/${CLIP_ID}`);
    const thumbnail = await get(`/clips/${CLIP_ID}/thumbnail`);

    expect(video.status).toBe(404);
    expect(thumbnail.status).toBe(404);
    expect(hasura.query).toHaveBeenCalledWith(expect.anything(), STRANGER);
    expect(s3.stat).not.toHaveBeenCalled();
  });

  it("serves a private clip to the viewer Hasura shows it to", async () => {
    visibility = "private";
    viewer = { steam_id: OWNER, role: "user" };

    const video = await get(`/clips/${CLIP_ID}`);
    const thumbnail = await get(`/clips/${CLIP_ID}/thumbnail`);

    expect(video.status).toBe(200);
    expect(thumbnail.status).toBe(200);
  });

  it("never lets a hidden clip be cached by something shared", async () => {
    visibility = "private";
    viewer = { steam_id: OWNER, role: "user" };

    const video = await get(`/clips/${CLIP_ID}`);

    expect(video.headers["cache-control"]).toMatch(/^private/);
  });
});
