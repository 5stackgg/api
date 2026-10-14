import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getQueueToken } from "@nestjs/bullmq";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { NotificationsQueues } from "../enums/NotificationsQueues";
import { PushNotificationsController } from "./push-notifications.controller";
import { PushNotificationsService } from "./push-notifications.service";

const VICTIM = "76561198000000001";
const ATTACKER_ENDPOINT = "https://fcm.googleapis.com/fcm/send/attacker-device";

// Over HTTP with main.ts's body parsers, because what a cross-site form can
// make of this route is the thing under test.
describe("PushNotificationsController subscribe", () => {
  let app: NestExpressApplication;
  let service: { subscribe: jest.Mock; unsubscribe: jest.Mock };

  beforeEach(async () => {
    service = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      controllers: [PushNotificationsController],
      providers: [
        { provide: PushNotificationsService, useValue: service },
        {
          provide: getQueueToken(NotificationsQueues.PushBroadcast),
          useValue: { add: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: () => ({
              webDomain: "https://5stack.gg",
              authCookieDomain: ".5stack.gg",
            }),
          },
        },
        { provide: Logger, useValue: { warn: jest.fn() } },
      ],
    }).compile();

    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    app.useBodyParser("json", { limit: "50mb" });
    app.useBodyParser("urlencoded", { limit: "50mb", extended: true });
    // What passport does with the victim's session cookie.
    app.use((req: any, _res: unknown, next: () => void) => {
      req.user = { steam_id: VICTIM, role: "user" };
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("saves the panel's JSON subscription for the signed-in player", async () => {
    await request(app.getHttpServer())
      .post("/notifications/push/subscribe")
      .send({
        subscription: {
          endpoint: ATTACKER_ENDPOINT,
          keys: { p256dh: "p256dh", auth: "auth" },
        },
      })
      .expect(201);

    expect(service.subscribe).toHaveBeenCalledWith(
      VICTIM,
      {
        endpoint: ATTACKER_ENDPOINT,
        keys: { p256dh: "p256dh", auth: "auth" },
      },
      undefined,
    );
  });

  it("refuses a form post, which a cross-site page can send with the player's cookie", async () => {
    await request(app.getHttpServer())
      .post("/notifications/push/subscribe")
      .type("form")
      .send(
        `subscription[endpoint]=${encodeURIComponent(ATTACKER_ENDPOINT)}` +
          "&subscription[keys][p256dh]=attacker-key" +
          "&subscription[keys][auth]=attacker-auth",
      )
      .expect(415);

    expect(service.subscribe).not.toHaveBeenCalled();
  });

  it("refuses a text/plain post, the other body a form can send", async () => {
    await request(app.getHttpServer())
      .post("/notifications/push/subscribe")
      .set("Content-Type", "text/plain")
      .send(JSON.stringify({ subscription: { endpoint: ATTACKER_ENDPOINT } }))
      .expect(415);

    expect(service.subscribe).not.toHaveBeenCalled();
  });
});
