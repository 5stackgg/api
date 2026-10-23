import { Controller, INestApplication, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  HasuraAction,
  HasuraController,
  HasuraEvent,
} from "./hasura.controller";
import { HasuraService } from "./hasura.service";
import { CacheService } from "../cache/cache.service";
import { PostgresService } from "../postgres/postgres.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";

const handled: Array<{ kind: string; data: Record<string, unknown> }> = [];
let countedRuns = 0;
let holdCounted: Promise<void> = Promise.resolve();

@Controller()
class HookSpecController {
  @HasuraAction()
  public async hookSpecAction(data: Record<string, unknown>) {
    handled.push({ kind: "action", data });
    return { ok: true };
  }

  @HasuraAction()
  public async hookSpecLanAction(data: {
    lanRegions: () => Promise<Array<string>>;
  }) {
    return { lanRegions: await data.lanRegions() };
  }

  @HasuraEvent()
  public async hook_spec_event(data: Record<string, unknown>) {
    handled.push({ kind: "event", data });
  }

  @HasuraEvent()
  public async hook_spec_failing_event() {
    throw new Error("redis went away");
  }

  @HasuraEvent({ retry: true })
  public async hook_spec_retried_event() {
    countedRuns++;
    throw new Error("redis went away");
  }

  @HasuraEvent({ retry: true })
  public async hook_spec_counted_event() {
    countedRuns++;
    await holdCounted;
  }
}

const actionBody = {
  action: { name: "hookSpecAction" },
  input: { match_id: "1" },
  session_variables: { "x-hasura-role": "admin" },
};

const eventBody = {
  trigger: { name: "hook_spec_event" },
  event: { op: "INSERT", data: { old: null as unknown, new: { id: "1" } } },
};

describe("HasuraController hooks", () => {
  let app: INestApplication;

  beforeEach(async () => {
    handled.length = 0;
    countedRuns = 0;
    holdCounted = Promise.resolve();

    const cached = new Map<string, unknown>();
    const cache = {
      has: async (key: string) => cached.has(key),
      put: async (key: string, value: unknown) => {
        cached.set(key, value);
      },
      acquireLock: async (key: string) => {
        if (cached.has(key)) {
          return null;
        }
        cached.set(key, "token");
        return "token";
      },
      releaseLock: async (key: string) => cached.delete(key),
    };

    const module = await Test.createTestingModule({
      controllers: [HasuraController, HookSpecController],
      providers: [
        HasuraService,
        {
          provide: Logger,
          useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
        { provide: CacheService, useValue: cache },
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
          useValue: {
            getConnection: () => ({
              hgetall: async (key: string) =>
                key === "latency-test:session-1"
                  ? {
                      lan: JSON.stringify({
                        region: "Lan",
                        latency: 1,
                        isLan: true,
                      }),
                    }
                  : {},
            }),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    app.use((req: any, _res: unknown, next: () => void) => {
      req.session = { id: "session-1" };
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const action = () => request(app.getHttpServer()).post("/hasura/actions");
  const event = () => request(app.getHttpServer()).post("/hasura/events");

  it("runs a JSON action", async () => {
    const response = await action().send(actionBody);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
    expect(handled).toEqual([
      { kind: "action", data: expect.objectContaining({ match_id: "1" }) },
    ]);
  });

  it("hands an action the LAN regions of the caller's session, not the body's", async () => {
    const response = await action().send({
      action: { name: "hookSpecLanAction" },
      input: {},
      session_variables: {
        "x-hasura-role": "user",
        "x-hasura-lan-regions": JSON.stringify(["Forged"]),
      },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ lanRegions: ["Lan"] });
  });

  it("runs a JSON event", async () => {
    const response = await event().send(eventBody);

    expect(response.status).toBeLessThan(300);
    expect(handled).toEqual([
      { kind: "event", data: { op: "INSERT", old: {}, new: { id: "1" } } },
    ]);
  });

  it("asks Hasura to send a retryable event again when its handler fails", async () => {
    const response = await event().send({
      ...eventBody,
      trigger: { name: "hook_spec_retried_event" },
    });

    expect(response.status).toBe(500);
  });

  const delivery = (name: string, id = "event-1") => ({
    ...eventBody,
    id,
    trigger: { name },
  });

  it("runs a retried event once when Hasura sends it again after it succeeded", async () => {
    const first = await event().send(delivery("hook_spec_counted_event"));
    const again = await event().send(delivery("hook_spec_counted_event"));

    expect(first.status).toBeLessThan(300);
    expect(again.status).toBeLessThan(300);
    expect(countedRuns).toBe(1);
  });

  it("turns away a copy sent while the first attempt is still running", async () => {
    let release: () => void = () => {};
    holdCounted = new Promise((resolve) => {
      release = resolve;
    });

    const first = event()
      .send(delivery("hook_spec_counted_event"))
      .then((r) => r);
    while (countedRuns === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const copy = await event().send(delivery("hook_spec_counted_event"));
    release();

    expect(copy.status).toBe(409);
    expect((await first).status).toBeLessThan(300);
    expect(countedRuns).toBe(1);
  });

  it("lets a failed event run again on Hasura's next attempt", async () => {
    const first = await event().send(delivery("hook_spec_retried_event"));
    const again = await event().send(delivery("hook_spec_retried_event"));

    expect(first.status).toBe(500);
    expect(again.status).toBe(500);
    expect(countedRuns).toBe(2);
  });

  it("keeps answering 2xx for a failed event that is not safe to run twice", async () => {
    const response = await event().send({
      ...eventBody,
      trigger: { name: "hook_spec_failing_event" },
    });

    expect(response.status).toBeLessThan(300);
  });

  it("refuses an action posted as a form, as a cross-site page would", async () => {
    const response = await action()
      .type("form")
      .send("action[name]=hookSpecAction&input[match_id]=1");

    expect(response.status).toBe(415);
    expect(handled).toEqual([]);
  });

  it("refuses an event posted as a form", async () => {
    const response = await event()
      .type("form")
      .send("trigger[name]=hook_spec_event&event[op]=INSERT");

    expect(response.status).toBe(415);
    expect(handled).toEqual([]);
  });
});
