import "reflect-metadata";

// sharp ships a native binary that is not installable on every dev machine, and
// importing AppModule pulls it in transitively. Nothing here calls it -- only
// the module metadata is read -- so a stub is enough, and without it this guard
// only runs on the platforms sharp happens to support.
jest.mock("sharp", () => ({ __esModule: true, default: () => ({}) }), {
  virtual: true,
});

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { BullBoardModule } from "@bull-board/nestjs";
import request from "supertest";
import { AppModule } from "./app.module";

// A module that imports another which (transitively) imports it back resolves to
// `undefined` at metadata-read time, and Nest refuses to boot with
// "the module at index [n] is undefined". Nothing else catches it: tsc is happy,
// every unit and SQL suite passes, and the failure only appears when the API
// starts.
//
// app.e2e-spec.ts was meant to cover this but has no it() block, so jest skips
// the file entirely. This walks the same graph without needing Redis, Postgres
// or any of the connections a real boot opens.
describe("module graph", () => {
  type ModuleClass = { name?: string };

  const walk = (
    root: ModuleClass,
  ): Array<{ module: string; index: number }> => {
    const problems: Array<{ module: string; index: number }> = [];
    const seen = new Set<unknown>();
    const queue: Array<ModuleClass> = [root];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (!current || seen.has(current)) {
        continue;
      }

      seen.add(current);

      const imports: Array<unknown> =
        Reflect.getMetadata("imports", current as object) ?? [];

      imports.forEach((imported, index) => {
        if (imported === undefined || imported === null) {
          problems.push({ module: current.name ?? "unknown", index });
          return;
        }

        // A dynamic module registration ({ module, providers, ... }) rather than
        // a class; follow the class it names.
        const target =
          typeof imported === "object" && "module" in (imported as object)
            ? (imported as { module: ModuleClass }).module
            : (imported as ModuleClass);

        if (typeof target === "function") {
          queue.push(target);
        }
      });
    }

    return problems;
  };

  it("has no undefined imports anywhere under AppModule", () => {
    const problems = walk(AppModule as ModuleClass);

    expect(
      problems.map(
        ({ module, index }) =>
          `${module} imports[${index}] is undefined (circular import?)`,
      ),
    ).toEqual([]);
  });
});

describe("bull board", () => {
  let app: INestApplication;
  let viewer: { steam_id: string; role: string } | undefined;
  let peer: string | undefined;

  beforeAll(async () => {
    const imports: Array<{ module?: unknown }> =
      Reflect.getMetadata("imports", AppModule) ?? [];
    const bullBoard = imports.find(
      (imported) => imported?.module === BullBoardModule,
    );

    const module = await Test.createTestingModule({
      imports: [bullBoard as never],
    }).compile();

    app = module.createNestApplication({ logger: false });
    (app as any).set("trust proxy", 1);
    app.use((req: any, _res: unknown, next: () => void) => {
      req.user = viewer;
      if (peer) {
        Object.defineProperty(req.socket, "remoteAddress", {
          value: peer,
          configurable: true,
        });
      }
      next();
    });
    await app.init();
  });

  beforeEach(() => {
    viewer = undefined;
    peer = "10.42.0.7";
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it.each(["/queues", "/queues/api/queues"])(
    "refuses %s to an anonymous request from another pod",
    async (path) => {
      expect((await get(path)).status).toBe(403);
    },
  );

  it("refuses a signed-in player below administrator", async () => {
    viewer = { steam_id: "76561198000000001", role: "tournament_organizer" };

    expect((await get("/queues/api/queues")).status).toBe(403);
  });

  it("serves an administrator", async () => {
    viewer = { steam_id: "76561198000000001", role: "administrator" };

    expect((await get("/queues/api/queues")).status).toBe(200);
  });

  it("serves a kubectl port-forward, which arrives on the pod's loopback", async () => {
    peer = undefined;

    expect((await get("/queues/api/queues")).status).toBe(200);
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "serves an anonymous request whose socket peer is %s",
    async (address) => {
      peer = address;

      expect((await get("/queues/api/queues")).status).toBe(200);
    },
  );

  it("refuses a request that only claims loopback in X-Forwarded-For", async () => {
    const response = await get("/queues/api/queues").set(
      "X-Forwarded-For",
      "127.0.0.1",
    );

    expect(response.status).toBe(403);
  });
});
