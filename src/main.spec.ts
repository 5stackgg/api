import "reflect-metadata";

jest.mock("./app.module", () => ({ AppModule: class AppModule {} }));

import { EventEmitter } from "events";
import { INestApplication } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import {
  closeOnShutdownSignals,
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_ENDPOINT_DELAY_MS,
  SHUTDOWN_REQUEST_DRAIN_MS,
} from "./main";

class QueueProcessor extends WorkerHost {
  constructor(close: () => Promise<void>) {
    super();
    (this as unknown as { _worker: unknown })._worker = { close };
  }

  async process() {}
}

// A job class extends WorkerHost too, but only a processor gets a worker.
class Job extends WorkerHost {
  async process() {}
}

type FakeResponse = EventEmitter & {
  headersSent: boolean;
  setHeader: jest.Mock;
};

describe("closeOnShutdownSignals", () => {
  const signals = ["SIGTERM", "SIGINT"] as const;
  const listenersBefore = new Map<string, Array<Function>>();
  let events: Array<string>;
  let server: EventEmitter & {
    close: jest.Mock;
    closeIdleConnections: jest.Mock;
  };
  let app: { close: jest.Mock };
  let exit: jest.SpyInstance;
  let closeWorker: jest.Mock<Promise<void>, []>;
  const dev = process.env.DEV;

  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.DEV;
    events = [];
    closeWorker = jest.fn(async () => {
      events.push("workers closed");
    });
    for (const signal of signals) {
      listenersBefore.set(signal, process.listeners(signal));
    }
    exit = jest.spyOn(process, "exit").mockImplementation((code): never => {
      events.push(`exit ${code}`);
      return undefined as never;
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});

    server = Object.assign(new EventEmitter(), {
      close: jest.fn(() => events.push("stopped listening")),
      closeIdleConnections: jest.fn(),
    });
    app = { close: jest.fn() };
    closeOnShutdownSignals({
      ...app,
      getHttpServer: () => server,
      get: () => ({
        getProviders: () => [
          { instance: new QueueProcessor(() => closeWorker()) },
          { instance: new Job() },
          { instance: {} },
        ],
      }),
    } as unknown as INestApplication);
  });

  afterEach(() => {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!listenersBefore.get(signal)!.includes(listener)) {
          process.removeListener(signal, listener as () => void);
        }
      }
    }
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (dev === undefined) {
      delete process.env.DEV;
    } else {
      process.env.DEV = dev;
    }
  });

  // A real signal hands its listeners the signal's name.
  const signal = (name: NodeJS.Signals) => process.emit(name, name);

  const request = () => {
    const response = Object.assign(new EventEmitter(), {
      headersSent: false,
      setHeader: jest.fn(),
    }) as FakeResponse;
    server.emit("request", {}, response);
    return response;
  };

  it("on SIGTERM closes the workers at once, keeps serving while its endpoints go, then stops listening and exits", async () => {
    signal("SIGTERM");
    await jest.advanceTimersByTimeAsync(SHUTDOWN_ENDPOINT_DELAY_MS - 1);
    expect(events).toEqual(["workers closed"]);

    await jest.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["workers closed", "stopped listening", "exit 0"]);
  });

  it("closes no app, and so no socket", async () => {
    signal("SIGTERM");
    await jest.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);

    expect(app.close).not.toHaveBeenCalled();
  });

  it("on SIGINT stops listening at once", async () => {
    signal("SIGINT");
    await jest.advanceTimersByTimeAsync(0);

    expect(events).toEqual(["workers closed", "stopped listening", "exit 0"]);
  });

  // A dev restart (start:dev, the hot-swap pod) has to come straight back.
  it.each(signals)(
    "in dev, on %s stops listening and exits at once, without waiting for the workers",
    async (name) => {
      process.env.DEV = "true";
      closeWorker.mockImplementation(() => new Promise(() => {}));

      signal(name);

      expect(events).toEqual(["stopped listening", "exit 0"]);
      expect(closeWorker).not.toHaveBeenCalled();
    },
  );

  it("lets a request in flight finish before it exits", async () => {
    const response = request();

    signal("SIGINT");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(["workers closed", "stopped listening"]);

    response.emit("close");
    await jest.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toBe("exit 0");
  });

  // Hasura keeps pooled connections to the old pod, which can still bring in
  // a request after the listener is gone.
  it("waits for a request that arrives on a kept-alive connection after the listener closed", async () => {
    signal("SIGINT");
    const late = request();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(exit).not.toHaveBeenCalled();

    late.emit("close");
    await jest.advanceTimersByTimeAsync(0);
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("keeps waiting when a new request comes in as the last one finishes", async () => {
    const first = request();

    signal("SIGINT");
    await jest.advanceTimersByTimeAsync(0);
    first.emit("close");
    const second = request();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(exit).not.toHaveBeenCalled();

    second.emit("close");
    await jest.advanceTimersByTimeAsync(0);
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("tells clients to close their connections once it is shutting down", async () => {
    const before = request();
    const sent = Object.assign(request(), { headersSent: true });

    signal("SIGTERM");
    const after = request();

    expect(before.setHeader).toHaveBeenCalledWith("Connection", "close");
    expect(after.setHeader).toHaveBeenCalledWith("Connection", "close");
    expect(sent.setHeader).not.toHaveBeenCalled();

    before.emit("close");
    expect(server.closeIdleConnections).toHaveBeenCalled();
  });

  it("gives up on a request that doesn't finish after the drain limit", async () => {
    request();

    signal("SIGINT");
    await jest.advanceTimersByTimeAsync(SHUTDOWN_REQUEST_DRAIN_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("exits at once on a second signal", async () => {
    signal("SIGTERM");
    signal("SIGINT");

    expect(exit.mock.calls).toEqual([[1]]);
    expect(server.close).not.toHaveBeenCalled();
  });

  it("exits cleanly even when a worker fails to close", async () => {
    closeWorker.mockImplementation(async () => {
      throw new Error("redis went away");
    });

    signal("SIGINT");
    await jest.advanceTimersByTimeAsync(0);

    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("gives up at the deadline, using most of the pod's grace period", async () => {
    closeWorker.mockImplementation(() => new Promise(() => {}));

    signal("SIGTERM");
    await jest.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThanOrEqual(25_000);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(30_000);
    expect(SHUTDOWN_ENDPOINT_DELAY_MS + SHUTDOWN_REQUEST_DRAIN_MS).toBeLessThan(
      SHUTDOWN_DEADLINE_MS,
    );
  });
});
