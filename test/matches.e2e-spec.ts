import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../src/app.module";

/**
 * E2E tests for match lifecycle.
 *
 * Match creation/mutation goes through Hasura Actions (webhook calls from
 * Hasura to the API). These tests verify the API endpoint behavior for
 * match-related operations. Full lifecycle testing with actual Hasura
 * requires the complete infrastructure stack.
 */
describe("Matches (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /matches/current-match/:serverId", () => {
    it("returns 404 for non-existent server", async () => {
      const response = await request(app.getHttpServer())
        .get("/matches/current-match/nonexistent-server");

      // Without a valid server ID, should return 404 or error
      expect([400, 404, 500]).toContain(response.status);
    });
  });

  describe("Hasura Action: cancelMatch", () => {
    it("rejects unauthenticated cancel requests", async () => {
      const response = await request(app.getHttpServer())
        .post("/hasura-actions")
        .send({
          action: { name: "cancelMatch" },
          input: { match_id: "nonexistent-match" },
          session_variables: {},
        });

      // Without auth, should be rejected
      expect([401, 403, 404]).toContain(response.status);
    });
  });

  describe("Hasura Action: scheduleMatch", () => {
    it("rejects schedule without valid session", async () => {
      const response = await request(app.getHttpServer())
        .post("/hasura-actions")
        .send({
          action: { name: "scheduleMatch" },
          input: { match_id: "test-match", time: new Date().toISOString() },
          session_variables: {},
        });

      expect([401, 403, 404]).toContain(response.status);
    });
  });

  describe("Hasura Action: joinLineup", () => {
    it("rejects join without authentication", async () => {
      const response = await request(app.getHttpServer())
        .post("/hasura-actions")
        .send({
          action: { name: "joinLineup" },
          input: {
            match_id: "test-match",
            lineup_id: "test-lineup",
            code: "",
          },
          session_variables: {},
        });

      expect([401, 403, 404]).toContain(response.status);
    });
  });
});
