import { INestApplication, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HasuraController } from "./hasura.controller";
import { HasuraService } from "./hasura.service";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";

// Hasura asks GET /hasura who a request or socket belongs to; the session the
// app's middleware put on the request decides the answer.
describe("HasuraController auth hook", () => {
  let app: INestApplication;
  let signedIn: { steam_id: string } | undefined;

  beforeEach(async () => {
    signedIn = undefined;
    jest
      .spyOn(HasuraService.prototype, "getHasuraHeaders")
      .mockImplementation(async (steamId: string) => ({
        "x-hasura-user-id": steamId,
        "x-hasura-role": "user",
      }));

    const module = await Test.createTestingModule({
      controllers: [HasuraController],
      providers: [
        HasuraService,
        {
          provide: Logger,
          useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
        { provide: CacheService, useValue: {} },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            hasura: { endpoint: "http://hasura:8080", secret: "secret" },
            app: {},
          }),
        },
        { provide: PostgresService, useValue: { query: jest.fn() } },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    app.use((req: any, _res: unknown, next: () => void) => {
      req.user = signedIn;
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  const hook = () => request(app.getHttpServer()).get("/hasura");

  it("answers a signed-out request as a guest", async () => {
    const response = await hook().expect(200);
    expect(response.body).toEqual({
      "x-hasura-user-id": "0",
      "x-hasura-role": "guest",
    });
  });

  it("answers a signed-in request with the player's own session", async () => {
    signedIn = { steam_id: "76561198000000001" };
    const response = await hook().expect(200);
    expect(response.body).toEqual({
      "x-hasura-user-id": "76561198000000001",
      "x-hasura-role": "user",
    });
  });
});
