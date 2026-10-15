import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { registerBodyParsers } from "./body-parsers";

@Controller()
class EchoController {
  @Post("*path")
  @HttpCode(200)
  public echo(@Body() body: unknown) {
    return { bytes: JSON.stringify(body ?? null).length };
  }
}

const MB = 1024 * 1024;

const jsonOf = (bytes: number) => ({ pad: "x".repeat(bytes) });

describe("registerBodyParsers", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      { module: class {}, controllers: [EchoController] } as any,
      { logger: false },
    );
    registerBodyParsers(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string) => request(app.getHttpServer()).post(path);

  it("refuses a JSON body over 1mb on an ordinary route, before any handler", async () => {
    const response = await post("/matches/anything").send(jsonOf(2 * MB));

    expect(response.status).toBe(413);
  });

  it("refuses a form body over 1mb the same way", async () => {
    const response = await post("/telemetry")
      .type("form")
      .send(`pad=${"x".repeat(2 * MB)}`);

    expect(response.status).toBe(413);
  });

  it("still reads an ordinary body under 1mb", async () => {
    const response = await post("/matches/anything").send(jsonOf(900 * 1024));

    expect(response.status).toBe(200);
    expect(response.body.bytes).toBeGreaterThan(900 * 1024);
  });

  it("reads Hasura's large action and event payloads", async () => {
    for (const path of ["/hasura/actions", "/hasura/events"]) {
      const response = await post(path).send(jsonOf(10 * MB));

      expect(response.status).toBe(200);
      expect(response.body.bytes).toBeGreaterThan(10 * MB);
    }
  });

  it("reads a recorded smoke's voxel log on the plugin's /utility routes", async () => {
    const log = Buffer.alloc(MB).toString("base64");

    const response = await post("/utility/lineup-1/smoke-voxels").send({
      log,
      samples: [],
    });

    expect(response.status).toBe(200);
  });

  it("caps /utility well short of the old limit", async () => {
    const response = await post("/utility/ingest").send(jsonOf(8 * MB));

    expect(response.status).toBe(413);
  });

  it("only widens the named path, not one that merely starts with it", async () => {
    const response = await post("/utility-lineups/import").send(
      jsonOf(2 * MB),
    );

    expect(response.status).toBe(413);
  });

  it("still reads a WHIP offer", async () => {
    const response = await post("/voice/lobby/whip")
      .set("content-type", "application/sdp")
      .send("v=0\r\n");

    expect(response.status).toBe(200);
  });
});
