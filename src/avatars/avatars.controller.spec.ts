import { BadRequestException, NotFoundException } from "@nestjs/common";
import { parse } from "querystring";
import { PassThrough, Readable } from "stream";
import sharp from "sharp";
import { AvatarsController } from "./avatars.controller";
import { AvatarsService } from "./avatars.service";

const png = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

type Stored = Record<string, { body: Buffer; type?: string }>;

function createController(objects: Stored) {
  const s3 = {
    has: jest.fn(async (key: string) => key in objects),
    get: jest.fn(async (key: string) => Readable.from([objects[key].body])),
    stat: jest.fn(async (key: string) => ({
      etag: "abc",
      metaData: { "content-type": objects[key].type },
    })),
  };
  const service = new AvatarsService({} as any, s3 as any, {} as any);
  return { controller: new AvatarsController(service), s3 };
}

function createRequest(path: string, rawQuery?: string) {
  return {
    originalUrl: rawQuery === undefined ? path : `${path}?${rawQuery}`,
    query: rawQuery === undefined ? {} : parse(rawQuery),
  } as any;
}

function createResponse() {
  const headers: Record<string, string> = {};
  const res = new PassThrough() as PassThrough & {
    setHeader: (name: string, value: string) => void;
  };
  res.setHeader = (name, value) => {
    headers[name.toLowerCase()] = value;
  };
  const body = new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve(Buffer.concat(chunks)));
  });
  return { res, headers, body };
}

describe("AvatarsController serving", () => {
  it("serves a webp no wider than the requested width", async () => {
    const { controller } = createController({
      "avatars/teams/logo.png": {
        body: await png(1024, 1024),
        type: "image/png",
      },
    });
    const { res, headers, body } = createResponse();

    await controller.serveTeam(
      "logo.png",
      createRequest("/avatars/teams/logo.png", "w=64"),
      res as any,
    );

    const image = await body;
    const meta = await sharp(image).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(64);
    expect(headers["content-type"]).toBe("image/webp");
    expect(headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(headers["etag"]).toBe("abc-w64");
  });

  it("never enlarges an image smaller than the requested width", async () => {
    const { controller } = createController({
      "avatars/players/small.png": { body: await png(40, 20) },
    });
    const { res, body } = createResponse();

    await controller.servePlayer(
      "small.png",
      createRequest("/avatars/players/small.png", "w=256"),
      res as any,
    );

    const meta = await sharp(await body).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(20);
  });

  it.each([
    ["a width outside the list", "w=100"],
    ["a padded width", "w=064"],
    ["a fractional width", "w=64.0"],
    ["a repeated width", "w=64&w=64"],
    ["a cache-busting second parameter", "w=64&x=1"],
    ["a trailing separator", "w=64&"],
    ["an escaped digit", "w=6%34"],
    ["an escaped key", "%77=64"],
    ["a second question mark", "w=64?x=1"],
  ])("refuses %s before touching storage", async (_label, rawQuery) => {
    const { controller, s3 } = createController({
      "avatars/teams/logo.png": { body: await png(64, 64) },
    });

    await expect(
      controller.serveTeam(
        "logo.png",
        createRequest("/avatars/teams/logo.png", rawQuery),
        createResponse().res as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s3.has).not.toHaveBeenCalled();
  });

  it("404s a resize of an avatar that does not exist", async () => {
    const { controller } = createController({});

    await expect(
      controller.serveTournament(
        "missing.png",
        createRequest("/avatars/tournaments/missing.png", "w=128"),
        createResponse().res as any,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("streams the original untouched without w, typed from its name when stored as octet-stream", async () => {
    const original = await png(300, 300);
    const { controller } = createController({
      "avatars/teams/logo.png": {
        body: original,
        type: "application/octet-stream",
      },
    });
    const { res, headers, body } = createResponse();

    await controller.serveTeam(
      "logo.png",
      createRequest("/avatars/teams/logo.png"),
      res as any,
    );

    expect((await body).equals(original)).toBe(true);
    expect(headers["content-type"]).toBe("image/png");
  });
});
