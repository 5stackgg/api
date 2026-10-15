import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { SnapshotController } from "./snapshot.controller";
import { GameStreamerService } from "./game-streamer.service";
import { StreamAccessService } from "./stream-access.service";
import { HasuraService } from "../../hasura/hasura.service";

const JOB = "0b7c2f5e-55a4-4c55-9d5e-6f1f4a8a1c11";
const VIEWER = "76561198000000001";
const FRAME = Buffer.from("jpeg");

// The progress frames of demo playback, shader bakes, clip renders and lineup
// renders sit on the public /snapshots ingress next to live ones, keyed by an
// id the page that shows them already has.
describe("SnapshotController", () => {
  let app: INestApplication;
  let viewer: { steam_id: string } | undefined;
  let readable: boolean;
  let hasura: { query: jest.Mock };
  let gameStreamer: { getSnapshot: jest.Mock };
  let requireLogin: boolean;

  beforeEach(async () => {
    viewer = undefined;
    readable = true;
    requireLogin = false;
    hasura = {
      query: jest.fn(async (selection: Record<string, unknown>) => {
        const [table] = Object.keys(selection);
        return { [table]: readable ? { id: JOB } : null };
      }),
    };
    gameStreamer = { getSnapshot: jest.fn().mockResolvedValue(FRAME) };

    const module = await Test.createTestingModule({
      controllers: [SnapshotController],
      providers: [
        { provide: GameStreamerService, useValue: gameStreamer },
        {
          provide: StreamAccessService,
          useValue: {
            requireLoginForLiveStreams: async () => requireLogin,
            authorize: async () => !!viewer,
          },
        },
        { provide: HasuraService, useValue: hasura },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    app.use((req: any, _res: any, next: () => void) => {
      req.user = viewer;
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (kind: string, id = JOB) =>
    request(app.getHttpServer()).get(`/snapshots/${kind}/${id}`);

  it.each([
    ["demo", "match_demo_sessions_by_pk"],
    ["bake", "game_server_nodes_by_pk"],
    ["clips", "clip_render_jobs_by_pk"],
    ["nades", "utility_lineup_renders_by_pk"],
  ])(
    "shows a %s frame to a viewer who may read its %s row, asked as them",
    async (kind, table) => {
      viewer = { steam_id: VIEWER };

      const response = await get(kind);

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, max-age=15");
      expect(hasura.query).toHaveBeenCalledWith(
        { [table]: { __args: { id: JOB }, id: true } },
        VIEWER,
      );
    },
  );

  it.each(["demo", "bake", "clips", "nades"])(
    "refuses a %s frame to a visitor who is not signed in",
    async (kind) => {
      const response = await get(kind);

      expect(response.status).toBe(403);
      expect(gameStreamer.getSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each(["demo", "bake", "clips", "nades"])(
    "refuses a %s frame to a viewer who may not read its row",
    async (kind) => {
      viewer = { steam_id: VIEWER };
      readable = false;

      const response = await get(kind);

      expect(response.status).toBe(403);
      expect(gameStreamer.getSnapshot).not.toHaveBeenCalled();
    },
  );

  it("refuses a frame whose id Hasura will not look up", async () => {
    viewer = { steam_id: VIEWER };
    hasura.query.mockRejectedValueOnce("invalid input syntax for type uuid");

    const response = await get("clips", "not-a-uuid");

    expect(response.status).toBe(403);
    expect(gameStreamer.getSnapshot).not.toHaveBeenCalled();
  });

  it("still shows a live frame to anyone when live streams need no login", async () => {
    const response = await get("live");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=15");
    expect(hasura.query).not.toHaveBeenCalled();
  });

  it("still refuses a live frame to a visitor when live streams need a login", async () => {
    requireLogin = true;

    const response = await get("live");

    expect(response.status).toBe(403);
  });
});
