import { INestApplication, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HasuraController } from "./hasura.controller";
import { HasuraService } from "./hasura.service";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import type { e_player_roles_enum } from "../../generated";

// Hasura asks GET /hasura who a request or socket belongs to; the session the
// app's middleware put on the request decides the answer.
describe("HasuraController auth hook", () => {
  let app: INestApplication;
  let signedIn: { steam_id: string } | undefined;
  let role: e_player_roles_enum;
  let latencyTests: Record<string, string>;
  let hgetall: jest.Mock;

  beforeEach(async () => {
    signedIn = undefined;
    role = "user";
    latencyTests = {};
    hgetall = jest.fn(async () => latencyTests);
    jest
      .spyOn(HasuraService.prototype, "getHasuraHeaders")
      .mockImplementation(async (steamId: string) => ({
        "x-hasura-user-id": steamId,
        "x-hasura-role": role,
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
        {
          provide: RedisManagerService,
          useValue: { getConnection: () => ({ hgetall }) },
        },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    app.use((req: any, _res: unknown, next: () => void) => {
      req.user = signedIn;
      req.session = { id: "session-1" };
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

  it("answers a signed-in socket that asks to be anonymous as a guest", async () => {
    signedIn = { steam_id: "76561198000000001" };
    const response = await hook()
      .set(HasuraController.ANONYMOUS_HEADER, "1")
      .expect(200);
    expect(response.body).toEqual({
      "x-hasura-user-id": "0",
      "x-hasura-role": "guest",
    });
  });

  it.each<e_player_roles_enum>([
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ])(
    "gives %s sessions a max-age so their sockets ask again",
    async (staff) => {
      signedIn = { steam_id: "76561198000000001" };
      role = staff;
      const response = await hook().expect(200);
      expect(response.body).toEqual({
        "x-hasura-user-id": "76561198000000001",
        "x-hasura-role": staff,
        "Cache-Control": "max-age=300",
      });
    },
  );

  it("answers an administrator's anonymous socket as a guest with no lifetime", async () => {
    signedIn = { steam_id: "76561198000000001" };
    role = "administrator";
    const response = await hook()
      .set(HasuraController.ANONYMOUS_HEADER, "1")
      .expect(200);
    expect(response.body).toEqual({
      "x-hasura-user-id": "0",
      "x-hasura-role": "guest",
    });
  });

  describe("LAN regions", () => {
    const probe = (region: string, isLan: boolean) =>
      JSON.stringify({ region, latency: 1, isLan });

    beforeEach(() => {
      signedIn = { steam_id: "76561198000000001" };
      latencyTests = {
        lan: probe("Lan", true),
        us_east: probe("US East", false),
      };
    });

    it("lists the LAN regions the probe placed the session on", async () => {
      const response = await hook().expect(200);
      expect(hgetall).toHaveBeenCalledWith("latency-test:session-1");
      expect(response.body).toEqual({
        "x-hasura-user-id": "76561198000000001",
        "x-hasura-role": "user",
        [HasuraController.LAN_REGIONS_SESSION_VARIABLE]: JSON.stringify([
          "Lan",
        ]),
      });
    });

    it("leaves the variable off a session on no LAN", async () => {
      latencyTests = { us_east: probe("US East", false) };
      const response = await hook().expect(200);
      expect(response.body).toEqual({
        "x-hasura-user-id": "76561198000000001",
        "x-hasura-role": "user",
      });
    });

    it.each<e_player_roles_enum>([
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ])("does not look a %s session up", async (staff) => {
      role = staff;
      const response = await hook().expect(200);
      expect(hgetall).not.toHaveBeenCalled();
      expect(
        response.body[HasuraController.LAN_REGIONS_SESSION_VARIABLE],
      ).toBeUndefined();
    });
  });
});
