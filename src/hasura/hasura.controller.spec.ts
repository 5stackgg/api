jest.mock("../../generated", () => ({
  createClient: jest.fn(),
}));

import { Logger } from "@nestjs/common";
import { HasuraController, HasuraAction, HasuraEvent } from "./hasura.controller";
import { Request, Response } from "express";

// Create a fake controller class to register actions and events against.
// The decorators populate module-level _actions/_events maps keyed by method name.
class FakeHandler {
  @HasuraAction()
  async testAction(data: Record<string, unknown>) {
    return { actionResult: true };
  }

  @HasuraAction()
  async me(data: Record<string, unknown>) {
    return { steam_id: (data as any).user?.steam_id };
  }

  @HasuraEvent()
  async testEvent(data: Record<string, unknown>) {
    return { eventResult: true };
  }
}

// We need access to the internal _actions and _events maps to clear cached
// resolved handlers between tests. We re-import the module to grab them.
// The decorators write to them when the class is declared above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const controllerModule = require("./hasura.controller");
// The module exports _actions and _events implicitly through the decorators;
// they live as closure variables. We cannot access them directly, but the
// `handler.resolved` cache on each entry is the problem. We work around this
// by putting the fakeHandlerInstance into a shared ref that all tests use,
// and clearing its resolved cache before each test.

// We keep a stable fakeHandlerInstance across tests. Each createController()
// will inject this same instance into the modulesContainer so getResolver
// always finds and caches THIS instance.
const sharedFakeHandler = new FakeHandler();

function createController() {
  const hasuraService = {
    getHasuraHeaders: jest.fn().mockResolvedValue({
      "x-hasura-role": "user",
      "x-hasura-user-id": "76561198000000001",
    }),
    checkSecret: jest.fn(),
    query: jest.fn(),
    mutation: jest.fn(),
  };

  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    verbose: jest.fn(),
  } as unknown as Logger;

  // Mock ModulesContainer: it's a Map of modules, each module has a controllers Map
  const modulesContainer = new Map();
  modulesContainer.set("TestModule", {
    name: "TestModule",
    controllers: new Map([
      [
        "FakeHandler",
        {
          name: FakeHandler.name,
          instance: sharedFakeHandler,
        },
      ],
    ]),
  });

  const controller = new HasuraController(
    logger,
    hasuraService as any,
    modulesContainer as any,
  );

  return { controller, hasuraService, logger, fakeHandlerInstance: sharedFakeHandler };
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    user: undefined,
    body: {},
    session: {},
    ...overrides,
  } as unknown as Request;
}

function makeResponse(): Response & {
  _status: number;
  _json: any;
} {
  const res = {
    _status: 200,
    _json: undefined,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: any) {
      res._json = data;
      return res;
    },
  } as any;
  return res;
}

describe("HasuraController", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe("hasura (GET)", () => {
    it("returns guest headers when no user on request", async () => {
      const { controller } = createController();
      const request = makeRequest({ user: undefined });

      const result = await controller.hasura(request);

      expect(result).toEqual({
        "x-hasura-user-id": "0",
        "x-hasura-role": "guest",
      });
    });

    it("returns user headers for authenticated user", async () => {
      const { controller, hasuraService } = createController();
      const request = makeRequest({
        user: { steam_id: "76561198000000001" } as any,
      });

      const result = await controller.hasura(request);

      expect(hasuraService.getHasuraHeaders).toHaveBeenCalledWith(
        "76561198000000001",
      );
      expect(result).toEqual({
        "x-hasura-role": "user",
        "x-hasura-user-id": "76561198000000001",
      });
    });
  });

  describe("actions (POST)", () => {
    it("resolves and calls the action handler successfully", async () => {
      const { controller } = createController();
      const request = makeRequest({
        body: {
          input: { someField: "value" },
          action: { name: "testAction" },
        },
        user: { steam_id: "76561198000000001" } as any,
      });
      const response = makeResponse();

      await controller.actions(request, response);

      expect(response._json).toEqual({ actionResult: true });
    });

    it("returns 401 for 'me' action when no user", async () => {
      const { controller } = createController();
      const request = makeRequest({
        body: {
          input: {},
          action: { name: "me" },
        },
        user: undefined,
      });
      const response = makeResponse();

      await controller.actions(request, response);

      expect(response._status).toBe(401);
      expect(response._json).toEqual({ message: "Unauthorized" });
    });

    it("returns 400 when action handler throws", async () => {
      const { controller, fakeHandlerInstance, logger } = createController();
      jest
        .spyOn(fakeHandlerInstance, "testAction")
        .mockRejectedValueOnce(new Error("action failed"));

      const request = makeRequest({
        body: {
          input: {},
          action: { name: "testAction" },
        },
        user: { steam_id: "76561198000000001" } as any,
      });
      const response = makeResponse();

      await controller.actions(request, response);

      expect(response._status).toBe(400);
      expect(response._json).toEqual({ message: "action failed" });
      expect((logger as any).error).toHaveBeenCalledWith(
        "unable to complete action testAction",
        expect.any(Error),
      );
    });

    it("returns 400 with string error when error has no message", async () => {
      const { controller, fakeHandlerInstance } = createController();
      jest
        .spyOn(fakeHandlerInstance, "testAction")
        .mockRejectedValueOnce("raw string error");

      const request = makeRequest({
        body: {
          input: {},
          action: { name: "testAction" },
        },
        user: { steam_id: "76561198000000001" } as any,
      });
      const response = makeResponse();

      await controller.actions(request, response);

      expect(response._status).toBe(400);
      expect(response._json).toEqual({ message: "raw string error" });
    });

    it("sets user and session on input before calling handler", async () => {
      const { controller, fakeHandlerInstance } = createController();
      const spy = jest
        .spyOn(fakeHandlerInstance, "testAction")
        .mockResolvedValue({ ok: true });

      const user = { steam_id: "76561198000000001" } as any;
      const session = { id: "sess-123" } as any;
      const request = makeRequest({
        body: {
          input: { someField: "value" },
          action: { name: "testAction" },
        },
        user,
        session,
      });
      const response = makeResponse();

      await controller.actions(request, response);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          someField: "value",
          user,
          session,
        }),
      );
    });
  });

  describe("events (POST)", () => {
    it("resolves and calls the event handler successfully", async () => {
      const { controller } = createController();
      const request = makeRequest({
        body: {
          event: {
            op: "INSERT",
            data: {
              old: null,
              new: { id: "1", name: "test" },
            },
          },
          trigger: { name: "testEvent" },
        },
      });

      const result = await controller.events(request);

      expect(result).toEqual({ eventResult: true });
    });

    it("passes old as empty object when null", async () => {
      const { controller, fakeHandlerInstance } = createController();
      const spy = jest
        .spyOn(fakeHandlerInstance, "testEvent")
        .mockResolvedValue({ ok: true });

      const request = makeRequest({
        body: {
          event: {
            op: "INSERT",
            data: {
              old: null,
              new: { id: "1" },
            },
          },
          trigger: { name: "testEvent" },
        },
      });

      await controller.events(request);

      expect(spy).toHaveBeenCalledWith({
        op: "INSERT",
        old: {},
        new: { id: "1" },
      });
    });

    it("passes new as empty object when null", async () => {
      const { controller, fakeHandlerInstance } = createController();
      const spy = jest
        .spyOn(fakeHandlerInstance, "testEvent")
        .mockResolvedValue({ ok: true });

      const request = makeRequest({
        body: {
          event: {
            op: "DELETE",
            data: {
              old: { id: "1" },
              new: null,
            },
          },
          trigger: { name: "testEvent" },
        },
      });

      await controller.events(request);

      expect(spy).toHaveBeenCalledWith({
        op: "DELETE",
        old: { id: "1" },
        new: {},
      });
    });

    it("logs error when event handler throws", async () => {
      const { controller, fakeHandlerInstance, logger } = createController();
      jest
        .spyOn(fakeHandlerInstance, "testEvent")
        .mockRejectedValueOnce(new Error("event failed"));

      const request = makeRequest({
        body: {
          event: {
            op: "UPDATE",
            data: { old: {}, new: {} },
          },
          trigger: { name: "testEvent" },
        },
      });

      // events() catches errors and logs them; should not throw
      await controller.events(request);

      expect((logger as any).error).toHaveBeenCalledWith(
        "unable to complete event testEvent",
        expect.objectContaining({
          error: expect.any(Error),
          event: expect.any(Object),
          trigger: expect.objectContaining({ name: "testEvent" }),
        }),
      );
    });
  });

  describe("getResolver", () => {
    it("throws when handler target cannot be resolved", async () => {
      const { controller } = createController();

      const request = makeRequest({
        body: {
          input: {},
          action: { name: "nonExistentAction" },
        },
        user: { steam_id: "76561198000000001" } as any,
      });
      const response = makeResponse();

      // nonExistentAction is not registered, so accessing _actions[action.name]
      // will be undefined, causing a TypeError when getResolver tries to access handler.resolved
      await expect(
        controller.actions(request, response),
      ).rejects.toThrow();
    });

    it("caches resolved handler on second call", async () => {
      const { controller } = createController();

      const request1 = makeRequest({
        body: {
          input: {},
          action: { name: "testAction" },
        },
        user: { steam_id: "76561198000000001" } as any,
      });
      const request2 = makeRequest({
        body: {
          input: {},
          action: { name: "testAction" },
        },
        user: { steam_id: "76561198000000001" } as any,
      });
      const response1 = makeResponse();
      const response2 = makeResponse();

      await controller.actions(request1, response1);
      await controller.actions(request2, response2);

      // Both should succeed since the resolver is cached after first call
      expect(response1._json).toEqual({ actionResult: true });
      expect(response2._json).toEqual({ actionResult: true });
    });
  });
});
