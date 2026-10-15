import { ForbiddenException, INestApplication, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import http from "http";
import { AddressInfo } from "net";
import { AvatarsController } from "./avatars/avatars.controller";
import { AvatarsService } from "./avatars/avatars.service";
import { AwardsController } from "./awards/awards.controller";
import { AwardsService } from "./awards/awards.service";
import { BrandingController } from "./branding/branding.controller";
import { BrandingService } from "./branding/branding.service";
import { BroadcastHudsController } from "./broadcast-huds/broadcast-huds.controller";
import { BroadcastHudsService } from "./broadcast-huds/broadcast-huds.service";
import { EventsController } from "./events/events.controller";
import { EventsService } from "./events/events.service";
import { NewsController } from "./news/news.controller";
import { NewsService } from "./news/news.service";
import { S3Service } from "./s3/s3.service";
import { SystemService } from "./system/system.service";

const MB = 1024 * 1024;
const TOURNAMENT = "5b1f3c1e-7d4a-4b6e-9a51-1c2d3e4f5a6b";
const EVENT = "0e8b7a6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c";
const MEDIA = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const USERS = {
  player: { steam_id: "76561198000000001", role: "user" },
  organizer: { steam_id: "76561198000000002", role: "tournament_organizer" },
  administrator: { steam_id: "76561198000000003", role: "administrator" },
} as const;

type Signed = keyof typeof USERS;

// `refused` is a signed-in player the route's own role check turns away;
// routes without one leave the decision to the service.
const ROUTES: Array<{
  path: string;
  field?: string;
  max: number;
  allowed: Signed;
  refused?: Signed;
}> = [
  { path: "/avatars/teams/team-1", max: 5 * MB, allowed: "player" },
  {
    path: "/avatars/players/76561198000000001",
    max: 5 * MB,
    allowed: "player",
  },
  {
    path: "/avatars/roster-players/76561198000000001",
    max: 5 * MB,
    allowed: "player",
  },
  {
    path: "/avatars/roster-teams/team-1/76561198000000001",
    max: 5 * MB,
    allowed: "player",
  },
  {
    path: `/avatars/tournaments/${TOURNAMENT}`,
    max: 5 * MB,
    allowed: "player",
  },
  {
    path: `/avatars/tournaments/${TOURNAMENT}/banner`,
    max: 10 * MB,
    allowed: "player",
  },
  {
    path: "/avatars/awards/award-1",
    max: 5 * MB,
    allowed: "administrator",
    refused: "organizer",
  },
  {
    path: `/avatars/awards/tournament/${TOURNAMENT}/1`,
    max: 5 * MB,
    allowed: "organizer",
    refused: "player",
  },
  {
    path: "/branding/upload",
    max: 5 * MB,
    allowed: "administrator",
    refused: "organizer",
  },
  {
    path: "/huds/import",
    field: "hud",
    max: 64 * MB,
    allowed: "administrator",
    refused: "organizer",
  },
  {
    path: `/events/media/${EVENT}/upload`,
    max: 90 * MB,
    allowed: "organizer",
    refused: "player",
  },
  {
    path: `/events/media/${EVENT}/${MEDIA}/thumbnail`,
    max: 3 * MB,
    allowed: "organizer",
    refused: "player",
  },
  {
    path: "/news/upload",
    max: 10 * MB,
    allowed: "administrator",
    refused: "organizer",
  },
  {
    path: "/news/upload/video",
    max: 90 * MB,
    allowed: "administrator",
    refused: "organizer",
  },
];

const BOUNDARY = "5stack-upload-boundary";

// Raw http rather than supertest: the cases below need a body that is still
// arriving, or one too big to hold, which supertest cannot send.
describe("upload routes", () => {
  let app: INestApplication;
  let port: number;

  const open = (path: string, field: string, size: number, as?: Signed) => {
    const head = Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="${field}"; filename="upload.png"\r\n` +
        "Content-Type: image/png\r\n\r\n",
    );
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);

    const request = http.request({
      port,
      method: "POST",
      path,
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": head.length + size + tail.length,
        ...(as ? { "x-test-user": as } : {}),
      },
    });

    const status = new Promise<number>((resolve, reject) => {
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
    });

    request.write(head);

    return { request, status, tail };
  };

  // Only the start of the file is ever sent, so an answer can only come from
  // something that decided without reading it.
  const answerBeforeBody = async (path: string, field: string, as?: Signed) => {
    const { request, status } = open(path, field, 50 * MB, as);
    request.write(Buffer.alloc(1024));

    let timer: NodeJS.Timeout;
    try {
      return await Promise.race([
        status,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("still waiting on the body")),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      request.destroy();
    }
  };

  const send = async (
    path: string,
    field: string,
    size: number,
    as: Signed,
  ) => {
    const { request, status, tail } = open(path, field, size, as);
    const chunk = Buffer.alloc(MB);

    for (let sent = 0; sent < size; sent += chunk.length) {
      const piece = chunk.subarray(0, Math.min(chunk.length, size - sent));
      if (!request.write(piece)) {
        await new Promise((resolve) => request.once("drain", resolve));
      }
    }
    request.end(tail);

    return await status;
  };

  beforeEach(async () => {
    const isOrganizer = (user: { steam_id: string; role: string }) =>
      user.steam_id === USERS.organizer.steam_id ||
      user.role === "administrator";

    const module = await Test.createTestingModule({
      controllers: [
        AvatarsController,
        AwardsController,
        BrandingController,
        BroadcastHudsController,
        EventsController,
        NewsController,
      ],
      providers: [
        { provide: AvatarsService, useValue: {} },
        {
          provide: AwardsService,
          useValue: {
            requireOrganizer: jest.fn(async (_id: string, user: any) => {
              if (!isOrganizer(user)) {
                throw new ForbiddenException("Not the tournament organizer");
              }
            }),
          },
        },
        { provide: BrandingService, useValue: {} },
        { provide: BroadcastHudsService, useValue: {} },
        {
          provide: EventsService,
          useValue: {
            assertCanUpload: jest.fn(async (_id: string, user: any) => {
              if (!user || !isOrganizer(user)) {
                throw new ForbiddenException("not an uploader");
              }
              return user;
            }),
          },
        },
        { provide: NewsService, useValue: {} },
        { provide: S3Service, useValue: {} },
        {
          provide: SystemService,
          useValue: {
            getSetting: jest.fn().mockResolvedValue("administrator"),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: () => ({
              webDomain: "https://5stack.gg",
              authCookieDomain: ".5stack.gg",
            }),
          },
        },
        {
          provide: Logger,
          useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    // What passport does with the session cookie.
    app.use((request: any, _response: unknown, next: () => void) => {
      request.user = USERS[request.headers["x-test-user"] as Signed];
      next();
    });
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
  });

  it.each(ROUTES)(
    "$path refuses an upload without a session before reading its body",
    async ({ path, field = "file" }) => {
      expect(await answerBeforeBody(path, field)).toBe(403);
    },
  );

  it.each(ROUTES.filter((route) => route.refused))(
    "$path refuses a $refused before reading the body",
    async ({ path, field = "file", refused }) => {
      expect(await answerBeforeBody(path, field, refused)).toBe(403);
    },
  );

  it.each(ROUTES)(
    "$path stops holding a $allowed's file past its limit",
    async ({ path, field = "file", max, allowed }) => {
      expect(await send(path, field, max + MB, allowed)).toBe(413);
    },
  );
});
