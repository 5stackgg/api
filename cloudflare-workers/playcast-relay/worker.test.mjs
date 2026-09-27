import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const ORIGIN = "https://relay.example.com";
const EDGE = "https://relay.example.workers.dev";

let originRequests;
let originRoutes;
let cache;

function respond(status, body = "", headers = {}) {
  return new Response(status === 204 ? null : body, { status, headers });
}

beforeEach(() => {
  originRequests = [];
  originRoutes = new Map();
  cache = new Map();

  globalThis.fetch = async (input) => {
    const target = typeof input === "string" ? input : input.url;
    originRequests.push(target);
    const route = originRoutes.get(target);
    return route ? route() : respond(404);
  };

  globalThis.caches = {
    default: {
      async match(request) {
        const hit = cache.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        cache.set(request.url, response.clone());
      },
    },
  };
});

async function get(path, env = { ORIGIN }) {
  const pending = [];
  const response = await worker.fetch(new Request(`${EDGE}${path}`), env, {
    waitUntil: (promise) => pending.push(promise),
  });
  await Promise.all(pending);
  return response;
}

function broadcast(token, fragments = {}) {
  originRoutes.set(`${ORIGIN}/match-1/sync`, () =>
    respond(200, JSON.stringify({ fragment: 42 }), {
      "X-Broadcast-Token": token,
    }),
  );
  for (const [path, body] of Object.entries(fragments)) {
    originRoutes.set(`${ORIGIN}/match-1/${token}/${path}`, () =>
      respond(200, body),
    );
  }
}

describe("playcast relay worker", () => {
  it("reports which panel it fronts", async () => {
    const response = await get("/health");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      origin: ORIGIN,
      version: "1",
    });
  });

  it("serves sync from the panel and keeps it for a few seconds", async () => {
    originRoutes.set(`${ORIGIN}/match-1/sync?fragment=0`, () =>
      respond(200, JSON.stringify({ fragment: 42 })),
    );

    const first = await get("/match-1/sync?fragment=0");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Cache-Control"), "public, max-age=3");
    assert.deepEqual(originRequests, [`${ORIGIN}/match-1/sync?fragment=0`]);

    await get("/match-1/sync?fragment=0");
    assert.equal(originRequests.length, 1);
  });

  it("fetches a fragment once and serves every other viewer from the edge", async () => {
    broadcast("s1t1", { "45/full": "full-45" });

    const first = await get("/match-1/45/full");
    assert.equal(await first.text(), "full-45");

    const second = await get("/match-1/45/full");
    assert.equal(await second.text(), "full-45");

    const scoped = await get("/match-1/s1t1/45/full");
    assert.equal(await scoped.text(), "full-45");

    assert.equal(
      originRequests.filter((url) => url.endsWith("/45/full")).length,
      1,
    );
  });

  it("lets only the token-scoped url be cached past the edge", async () => {
    broadcast("s1t1", { "45/full": "full-45" });

    const unscoped = await get("/match-1/45/full");
    assert.equal(unscoped.headers.get("Cache-Control"), "no-store");

    const scoped = await get("/match-1/s1t1/45/full");
    assert.match(scoped.headers.get("Cache-Control"), /immutable/);

    const unscopedHit = await get("/match-1/45/full");
    assert.equal(unscopedHit.headers.get("Cache-Control"), "no-store");
  });

  it("never passes on the panel's Content-Encoding", async () => {
    broadcast("s1t1");
    originRoutes.set(`${ORIGIN}/match-1/s1t1/45/full`, () =>
      respond(200, "full-45", { "Content-Encoding": "gzip" }),
    );

    const response = await get("/match-1/s1t1/45/full");

    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.equal(await response.text(), "full-45");
  });

  it("answers HEAD without a body", async () => {
    broadcast("s1t1", { "45/full": "full-45" });

    const pending = [];
    const response = await worker.fetch(
      new Request(`${EDGE}/match-1/s1t1/45/full`, { method: "HEAD" }),
      { ORIGIN },
      { waitUntil: (promise) => pending.push(promise) },
    );
    await Promise.all(pending);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  });

  it("never serves a new map the fragment an earlier map had at that number", async () => {
    broadcast("s1t1", { "3/full": "old-map" });
    assert.equal(await (await get("/match-1/3/full")).text(), "old-map");

    cache.delete(`${EDGE}/match-1/sync`);
    broadcast("s1t2", { "3/full": "new-map" });

    assert.equal(await (await get("/match-1/3/full")).text(), "new-map");
  });

  it("uses the token a client already has in its url", async () => {
    broadcast("s1t1", { "45/delta": "delta-45" });

    const response = await get("/match-1/s1t1/45/delta");

    assert.equal(await response.text(), "delta-45");
    assert.ok(!originRequests.some((url) => url.endsWith("/sync")));
  });

  it("does not cache a fragment the panel does not have yet", async () => {
    broadcast("s1t1");

    const missing = await get("/match-1/46/full");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("Cache-Control"), "no-store");

    originRoutes.set(`${ORIGIN}/match-1/s1t1/46/full`, () =>
      respond(200, "full-46"),
    );
    assert.equal(await (await get("/match-1/46/full")).text(), "full-46");
  });

  it("passes start through without caching it", async () => {
    originRoutes.set(`${ORIGIN}/match-1/42/start`, () =>
      respond(200, "start-42"),
    );

    const response = await get("/match-1/42/start");

    assert.equal(await response.text(), "start-42");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(cache.size, 0);
  });

  it("answers fragment requests from the panel when no broadcast is running", async () => {
    const response = await get("/match-1/45/full");

    assert.equal(response.status, 404);
    assert.ok(originRequests.includes(`${ORIGIN}/match-1/45/full`));
  });

  it("only serves reads", async () => {
    const pending = [];
    const response = await worker.fetch(
      new Request(`${EDGE}/match-1/s1t1/45/full`, { method: "POST" }),
      { ORIGIN },
      { waitUntil: (promise) => pending.push(promise) },
    );

    assert.equal(response.status, 405);
  });

  it("refuses to run without an origin", async () => {
    const response = await get("/match-1/sync", {});

    assert.equal(response.status, 500);
  });
});
