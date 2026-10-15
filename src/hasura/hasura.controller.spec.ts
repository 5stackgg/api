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

const handled: Array<{ kind: string; data: Record<string, unknown> }> = [];

@Controller()
class HookSpecController {
  @HasuraAction()
  public async hookSpecAction(data: Record<string, unknown>) {
    handled.push({ kind: "action", data });
    return { ok: true };
  }

  @HasuraEvent()
  public async hook_spec_event(data: Record<string, unknown>) {
    handled.push({ kind: "event", data });
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

    const module = await Test.createTestingModule({
      controllers: [HasuraController, HookSpecController],
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

  it("runs a JSON event", async () => {
    const response = await event().send(eventBody);

    expect(response.status).toBeLessThan(300);
    expect(handled).toEqual([
      { kind: "event", data: { op: "INSERT", old: {}, new: { id: "1" } } },
    ]);
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
