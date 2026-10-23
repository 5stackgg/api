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

describe("closeOnShutdownSignals", () => {
  const signals = ["SIGTERM", "SIGINT"] as const;
  const listenersBefore = new Map<string, Array<Function>>();
  let events: Array<string>;
  let server: EventEmitter & { close: jest.Mock };
  let app: { close: jest.Mock };
  let exit: jest.SpyInstance;
  let closeWorker: () => Promise<void>;
  const dev = process.env.DEV;

  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.DEV;
    events = [];
    closeWorker = async () => {
      events.push("workers closed");
    };
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

  const request = () => {
    const response = new EventEmitter();
    server.emit("request", {}, response);
    return () => response.emit("close");
  };

  it("on SIGTERM keeps serving while its endpoints go, then stops listening, closes the workers and exits", async () => {
    process.emit("SIGTERM", "SIGTERM");

    await jest.advanceTimersByTimeAsync(SHUTDOWN_ENDPOINT_DELAY_MS - 1);
    expect(events).toEqual([]);

    await jest.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["stopped listening", "workers closed", "exit 0"]);
  });

  it("closes no app, and so no socket", async () => {
    process.emit("SIGTERM", "SIGTERM");
    await jest.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);

    expect(app.close).not.toHaveBeenCalled();
  });

  it("in dev, on SIGTERM too, stops listening at once", async () => {
    process.env.DEV = "true";

    process.emit("SIGTERM", "SIGTERM");
    await jest.advanceTimersByTimeAsync(0);

    expect(events).toEqual(["stopped listening", "workers closed", "exit 0"]);
  });

  it("on SIGINT stops listening at once", async () => {
    process.emit("SIGINT", "SIGINT");
    await jest.advanceTimersByTimeAsync(0);

    expect(events).toEqual(["stopped listening", "workers closed", "exit 0"]);
  });

  it("lets a request in flight finish before it exits", async () => {
    const finish = request();

    process.emit("SIGINT", "SIGINT");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual(["stopped listening", "workers closed"]);

    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toBe("exit 0");
  });

  it("gives up on a request that doesn't finish after the drain limit", async () => {
    request();

    process.emit("SIGINT", "SIGINT");
    await jest.advanceTimersByTimeAsync(SHUTDOWN_REQUEST_DRAIN_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("exits at once on a second signal", async () => {
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");

    expect(exit.mock.calls).toEqual([[1]]);
    expect(server.close).not.toHaveBeenCalled();
  });

  it("exits cleanly even when a worker fails to close", async () => {
    closeWorker = async () => {
      throw new Error("redis went away");
    };

    process.emit("SIGINT", "SIGINT");
    await jest.advanceTimersByTimeAsync(0);

    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("gives up at the deadline, inside the pod's grace period", async () => {
    closeWorker = () => new Promise(() => {});

    process.emit("SIGTERM", "SIGTERM");
    await jest.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(30_000);
    expect(SHUTDOWN_ENDPOINT_DELAY_MS + SHUTDOWN_REQUEST_DRAIN_MS).toBeLessThan(
      SHUTDOWN_DEADLINE_MS,
    );
  });
});
