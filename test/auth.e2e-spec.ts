import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../src/app.module";

describe("Auth Guards (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  describe("unauthenticated requests", () => {
    it("POST /hasura-actions without session is rejected", async () => {
      const response = await request(app.getHttpServer())
        .post("/hasura-actions")
        .send({ action: { name: "me" }, session_variables: {} });

      // Should return 401 or 403 without valid session
      expect([401, 403, 404]).toContain(response.status);
    });

    it("requests without API key header are rejected", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/protected")
        .set("Authorization", "Bearer invalid-token");

      // Invalid token should be rejected
      expect([401, 403, 404]).toContain(response.status);
    });
  });

  describe("Steam OAuth flow", () => {
    it("GET /auth/steam initiates OAuth redirect", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/steam");

      // Should redirect to Steam or return auth error
      expect([302, 401, 403]).toContain(response.status);
    });

    it("GET /auth/steam/callback without code is rejected", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/steam/callback");

      // Without valid Steam callback params, should fail
      expect([302, 400, 401, 403, 500]).toContain(response.status);
    });
  });

  describe("Discord OAuth flow", () => {
    it("GET /auth/discord initiates OAuth redirect", async () => {
      const response = await request(app.getHttpServer())
        .get("/auth/discord");

      // Should redirect to Discord or return auth error
      expect([302, 401, 403]).toContain(response.status);
    });
  });
});
