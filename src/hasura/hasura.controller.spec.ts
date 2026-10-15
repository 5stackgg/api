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

const SECRET = "hook-secret-for-specs";
const HEADER = "x-5stack-hook-secret";

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

type Metadata = "with-secret" | "without-secret" | "unreadable";

const logger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const config = () =>
  new ConfigService({
    hasura: { endpoint: "http://hasura:8080", secret: SECRET },
    app: {},
  });

const probe = (state: { metadata: Metadata }) => ({
  query: jest.fn(async () => {
    if (state.metadata === "unreadable") {
      throw new Error('relation "hdb_catalog.hdb_metadata" does not exist');
    }
    return [{ enforced: state.metadata === "with-secret" }];
  }),
});

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
  let hasura: HasuraService;
  let state: { metadata: Metadata };
  let postgres: ReturnType<typeof probe>;

  const boot = async (metadata: Metadata) => {
    state.metadata = metadata;

    const module = await Test.createTestingModule({
      controllers: [HasuraController, HookSpecController],
      providers: [
        HasuraService,
        { provide: Logger, useValue: logger },
        { provide: CacheService, useValue: {} },
        { provide: ConfigService, useValue: config() },
        { provide: PostgresService, useValue: postgres },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    await app.init();
    hasura = app.get(HasuraService);
  };

  const action = () => request(app.getHttpServer()).post("/hasura/actions");
  const event = () => request(app.getHttpServer()).post("/hasura/events");

  beforeEach(() => {
    handled.length = 0;
    state = { metadata: "with-secret" };
    postgres = probe(state);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  describe("once the live metadata sends the secret", () => {
    beforeEach(() => boot("with-secret"));

    it("runs an action that carries the secret", async () => {
      const response = await action().set(HEADER, SECRET).send(actionBody);

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ ok: true });
      expect(handled).toEqual([
        { kind: "action", data: expect.objectContaining({ match_id: "1" }) },
      ]);
    });

    it("refuses an action without the secret", async () => {
      const response = await action().send(actionBody);

      expect(response.status).toBe(401);
      expect(handled).toEqual([]);
    });

    it("refuses an action with the wrong secret", async () => {
      const response = await action().set(HEADER, "guess").send(actionBody);

      expect(response.status).toBe(401);
      expect(handled).toEqual([]);
    });

    it("refuses a browser form post that would parse into an action", async () => {
      const response = await action()
        .set(HEADER, SECRET)
        .type("form")
        .send("action[name]=hookSpecAction&input[match_id]=1");

      expect(response.status).toBe(415);
      expect(handled).toEqual([]);
    });

    it("runs an event that carries the secret", async () => {
      const response = await event().set(HEADER, SECRET).send(eventBody);

      expect(response.status).toBeLessThan(300);
      expect(handled).toEqual([
        { kind: "event", data: { op: "INSERT", old: {}, new: { id: "1" } } },
      ]);
    });

    it("refuses an event without the secret", async () => {
      const response = await event().send(eventBody);

      expect(response.status).toBe(401);
      expect(handled).toEqual([]);
    });

    it("refuses an event with the wrong secret", async () => {
      const response = await event().set(HEADER, "guess").send(eventBody);

      expect(response.status).toBe(401);
      expect(handled).toEqual([]);
    });

    it("refuses an event that is not JSON", async () => {
      const response = await event()
        .set(HEADER, SECRET)
        .type("form")
        .send("trigger[name]=hook_spec_event&event[op]=INSERT");

      expect(response.status).toBe(415);
      expect(handled).toEqual([]);
    });
  });

  describe("while the live metadata predates the secret", () => {
    beforeEach(() => boot("without-secret"));

    it("reads the metadata before serving", () => {
      expect(postgres.query).toHaveBeenCalledWith(
        expect.stringContaining("hdb_catalog.hdb_metadata"),
        [HEADER],
      );
    });

    it("still runs an action and an event without the secret", async () => {
      expect((await action().send(actionBody)).status).toBe(201);
      expect((await event().send(eventBody)).status).toBeLessThan(300);
      expect(handled.map(({ kind }) => kind)).toEqual(["action", "event"]);
    });

    it("still refuses a wrong secret", async () => {
      const response = await action().set(HEADER, "guess").send(actionBody);

      expect(response.status).toBe(401);
      expect(handled).toEqual([]);
    });

    it("still refuses a form post", async () => {
      const response = await action()
        .type("form")
        .send("action[name]=hookSpecAction&input[match_id]=1");

      expect(response.status).toBe(415);
      expect(handled).toEqual([]);
    });

    it("starts requiring the secret once the metadata sends it, after a grace for other Hasura replicas", async () => {
      const now = Date.now();
      const clock = jest.spyOn(Date, "now").mockReturnValue(now);

      state.metadata = "with-secret";
      await hasura.refreshHookSecretMode();

      expect((await action().send(actionBody)).status).toBe(201);

      clock.mockReturnValue(now + HasuraService.HOOK_SECRET_GRACE_MS - 1);
      expect((await action().send(actionBody)).status).toBe(201);

      clock.mockReturnValue(now + HasuraService.HOOK_SECRET_GRACE_MS);
      expect((await action().send(actionBody)).status).toBe(401);
      expect((await event().send(eventBody)).status).toBe(401);
    });

    it("does not restart the grace on every probe once enforced", async () => {
      const now = Date.now();
      const clock = jest.spyOn(Date, "now").mockReturnValue(now);

      state.metadata = "with-secret";
      await hasura.refreshHookSecretMode();

      clock.mockReturnValue(now + HasuraService.HOOK_SECRET_GRACE_MS - 1);
      await hasura.refreshHookSecretMode();

      clock.mockReturnValue(now + HasuraService.HOOK_SECRET_GRACE_MS);
      expect((await action().send(actionBody)).status).toBe(401);
    });

    it("counts a failed probe as enforced", async () => {
      const now = Date.now();
      const clock = jest.spyOn(Date, "now").mockReturnValue(now);

      state.metadata = "unreadable";
      await hasura.refreshHookSecretMode();

      clock.mockReturnValue(now + HasuraService.HOOK_SECRET_GRACE_MS);
      expect((await action().send(actionBody)).status).toBe(401);
    });

    it("relaxes again if the metadata is rolled back", async () => {
      state.metadata = "with-secret";
      await hasura.refreshHookSecretMode();
      state.metadata = "without-secret";
      await hasura.refreshHookSecretMode();

      const clock = jest.spyOn(Date, "now");
      clock.mockReturnValue(Date.now() + HasuraService.HOOK_SECRET_GRACE_MS);

      expect((await action().send(actionBody)).status).toBe(201);
    });
  });

  describe("when the metadata cannot be read at boot", () => {
    beforeEach(() => boot("unreadable"));

    it("requires the secret straight away", async () => {
      expect((await action().send(actionBody)).status).toBe(401);
      expect((await event().send(eventBody)).status).toBe(401);
      expect((await action().set(HEADER, SECRET).send(actionBody)).status).toBe(
        201,
      );
    });
  });
});

describe("HasuraService hook secret probe", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("re-reads the live metadata on an interval until shutdown", async () => {
    jest.useFakeTimers();
    const postgres = probe({ metadata: "without-secret" });
    const service = new HasuraService(
      logger,
      null as never,
      config(),
      postgres as unknown as PostgresService,
    );

    await service.onApplicationBootstrap();
    expect(postgres.query).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(HasuraService.HOOK_SECRET_PROBE_MS);
    expect(postgres.query).toHaveBeenCalledTimes(2);

    service.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(HasuraService.HOOK_SECRET_PROBE_MS * 3);
    expect(postgres.query).toHaveBeenCalledTimes(2);
  });
});
