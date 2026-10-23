import "reflect-metadata";

jest.mock("./app.module", () => ({ AppModule: class AppModule {} }));

import {
  INestApplication,
  Injectable,
  OnApplicationShutdown,
  OnModuleDestroy,
} from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { WorkerHost } from "@nestjs/bullmq";
import { closeOnShutdownSignals, SHUTDOWN_DEADLINE_MS } from "./main";

const events: Array<string> = [];
let closeWorker: () => Promise<void>;

@Injectable()
class QueueProcessor extends WorkerHost {
  constructor() {
    super();
    (this as unknown as { _worker: unknown })._worker = {
      close: () => closeWorker(),
    };
  }

  async process() {}
}

// A job class extends WorkerHost too, but only a processor gets a worker.
@Injectable()
class Job extends WorkerHost {
  async process() {}
}

@Injectable()
class RedisConnections implements OnApplicationShutdown {
  onApplicationShutdown() {
    events.push("redis disconnected");
  }
}

@Injectable()
class S3Clients implements OnModuleDestroy {
  onModuleDestroy() {
    events.push("s3 destroyed");
  }
}

describe("closeOnShutdownSignals", () => {
  let app: INestApplication;
  let exit: jest.SpyInstance;
  const signals = ["SIGTERM", "SIGINT"] as const;
  const listenersBefore = new Map<string, Array<Function>>();

  beforeEach(async () => {
    events.length = 0;
    closeWorker = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      events.push("worker closed");
    };
    for (const signal of signals) {
      listenersBefore.set(signal, process.listeners(signal));
    }
    exit = jest
      .spyOn(process, "exit")
      .mockImplementation((): never => undefined as never);
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [QueueProcessor, Job, RedisConnections, S3Clients],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    closeOnShutdownSignals(app);
  });

  afterEach(() => {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!listenersBefore.get(signal)!.includes(listener)) {
          process.removeListener(signal, listener as () => void);
        }
      }
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it.each(signals)(
    "on %s lets the queue workers finish before anything they use is closed, then exits",
    async (signal) => {
      process.emit(signal);
      await settle();

      expect(events).toEqual([
        "worker closed",
        "s3 destroyed",
        "redis disconnected",
      ]);
      expect(exit).toHaveBeenCalledWith(0);
    },
  );

  it("ignores another signal while it is shutting down", async () => {
    const close = jest.spyOn(app, "close");

    process.emit("SIGTERM");
    process.emit("SIGINT");
    await settle();

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("exits with an error if shutting down fails", async () => {
    closeWorker = async () => {
      throw new Error("redis went away");
    };

    process.emit("SIGTERM");
    await settle();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("gives up at the deadline, inside the pod's grace period", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    closeWorker = () => new Promise(() => {});

    process.emit("SIGTERM");
    await settle();
    jest.advanceTimersByTime(SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(30_000);
  });
});
