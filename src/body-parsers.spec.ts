import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import http from "http";
import { AddressInfo } from "net";
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
    await app.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string) => request(app.getHttpServer()).post(path);

  const rawPost = (path: string, body: string) =>
    new Promise<number>((resolve, reject) => {
      const { port } = app.getHttpServer().address() as AddressInfo;
      const sent = http.request(
        {
          port,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      sent.on("error", reject);
      sent.end(body);
    });

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

  it("caps /utility at 2mb", async () => {
    const response = await post("/utility/ingest").send(jsonOf(3 * MB));

    expect(response.status).toBe(413);
  });

  it("still refuses a 2mb body on an ordinary route", async () => {
    const status = await rawPost(
      "/matches/anything",
      JSON.stringify(jsonOf(2 * MB)),
    );

    expect(status).toBe(413);
  });

  // nginx picks the ingress location by the normalised path but forwards the
  // raw one, which express matches as a case-insensitive prefix.
  it.each([
    "/hasura/%2e%2e/x",
    "/hasura/../x",
    "/HASURA/%2E%2E/x",
    "/hasura/.%2e/utility/x",
    "/hasura/./x",
    "/hasura/..",
    "/x/%2f..",
    "/hasura%2f..%2futility/x",
    "/hasura/%5C../utility",
  ])("refuses %s before any parser reads it", async (path) => {
    expect(await rawPost(path, JSON.stringify(jsonOf(10)))).toBe(400);
  });

  it("refuses a climbing path even with a body over every limit", async () => {
    const status = await rawPost(
      "/hasura/%2e%2e/utility/x",
      JSON.stringify(jsonOf(5 * MB)),
    );

    expect(status).toBe(400);
  });

  it.each([
    "/matches/anything?next=../a%2Fb",
    "/utility/lineup-1/trajectory",
    "/clips/utility/lineup-1/take.mp4",
    "/demos/match-1/pre-signed",
    "/match-relay/match-1/s123t456/7/delta?final=0",
  ])("leaves %s alone", async (path) => {
    expect(await rawPost(path, JSON.stringify(jsonOf(10)))).toBe(200);
  });

  it("only widens the named path, not one that merely starts with it", async () => {
    const response = await post("/utility-lineups/import").send(jsonOf(2 * MB));

    expect(response.status).toBe(413);
  });

  it("still reads a WHIP offer", async () => {
    const response = await post("/voice/lobby/whip")
      .set("content-type", "application/sdp")
      .send("v=0\r\n");

    expect(response.status).toBe(200);
  });
});
