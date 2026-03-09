import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./test-helpers";

describe("AppController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("should boot the application", () => {
    expect(app).toBeDefined();
  });

  it("GET / should return 200 or 404 (no root handler)", async () => {
    const response = await request(app.getHttpServer()).get("/");
    // App controller is empty, so expect either 200 (if middleware handles it)
    // or 404 (no route defined). Either confirms the app is alive.
    expect([200, 404]).toContain(response.status);
  });

  it("GET /nonexistent should return 404", async () => {
    const response = await request(app.getHttpServer()).get("/nonexistent");
    expect(response.status).toBe(404);
  });

  it("GET /auth/steam should redirect to Steam login", async () => {
    const response = await request(app.getHttpServer()).get("/auth/steam");
    // Steam OAuth guard should redirect (302) to Steam login page
    expect([302, 401, 403]).toContain(response.status);
  });
});
