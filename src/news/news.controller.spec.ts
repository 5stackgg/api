import { BadRequestException, INestApplication, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { Readable } from "stream";
import request from "supertest";
import { NewsController } from "./news.controller";
import { NewsService } from "./news.service";
import { S3Service } from "../s3/s3.service";
import { SystemService } from "../system/system.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";

// Passes the magic-byte check as a GIF, and is a page full of script to a
// browser told it is text/html.
const GIF_WITH_SCRIPT = Buffer.concat([
  Buffer.from("GIF89a"),
  Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from("<script>alert(document.domain)</script>"),
]);

describe("NewsController images", () => {
  let app: INestApplication;
  let controller: NewsController;
  let s3: { put: jest.Mock; has: jest.Mock; get: jest.Mock; stat: jest.Mock };

  const admin = {
    user: { steam_id: "76561198000000001", role: "administrator" },
  } as never;

  beforeEach(async () => {
    s3 = {
      put: jest.fn().mockResolvedValue(undefined),
      has: jest.fn().mockResolvedValue(true),
      get: jest.fn(async () => Readable.from([GIF_WITH_SCRIPT])),
      stat: jest.fn().mockResolvedValue({
        etag: "etag",
        metaData: { "content-type": "text/html" },
      }),
    };

    const module = await Test.createTestingModule({
      controllers: [NewsController],
      providers: [
        NewsService,
        { provide: S3Service, useValue: s3 },
        {
          provide: SystemService,
          useValue: { getSetting: jest.fn().mockResolvedValue("administrator") },
        },
        { provide: PostgresService, useValue: { query: jest.fn() } },
        { provide: NotificationsService, useValue: {} },
        { provide: Logger, useValue: { log: jest.fn(), error: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: () => ({
              webDomain: "https://5stack.gg",
              authCookieDomain: ".5stack.gg",
            }),
          },
        },
      ],
    }).compile();

    controller = module.get(NewsController);
    app = module.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("stores an upload as the image its bytes are, not the type its part claimed", async () => {
    const { filename } = await controller.upload(admin, {
      buffer: GIF_WITH_SCRIPT,
      mimetype: "text/html",
    } as Express.Multer.File);

    expect(filename).toMatch(/^[0-9a-f]{24}\.gif$/);
    expect(s3.put).toHaveBeenCalledWith(
      `news/${filename}`,
      GIF_WITH_SCRIPT,
      "image/gif",
    );
  });

  it("refuses bytes that are none of the image types", async () => {
    await expect(
      controller.upload(admin, {
        buffer: Buffer.from("<html><script>alert(1)</script></html>"),
        mimetype: "image/png",
      } as Express.Multer.File),
    ).rejects.toThrow(BadRequestException);

    expect(s3.put).not.toHaveBeenCalled();
  });

  it("serves an image stored with a script type as an image a browser will not render as a page", async () => {
    const response = await request(app.getHttpServer())
      .get("/news/image/0123456789abcdef01234567.png")
      .expect(200);

    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBe("sandbox");
  });
});
