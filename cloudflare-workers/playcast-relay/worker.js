// Edge cache in front of a 5stack panel's Playcast relay.
//
// Game servers keep posting to the panel; viewers (CS2 clients and the game
// streamer) read through this worker instead, so every fragment leaves the
// panel once per Cloudflare location rather than once per viewer.
//
// Fragment numbers start over when a new map starts a new broadcast, so a
// fragment is only cached under the broadcast token the panel reports on
// /sync. The same url can never be served data from an earlier broadcast.

const VERSION = "1";

const SYNC_CACHE_CONTROL = "public, max-age=3";
const FRAGMENT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const TOKEN_HEADER = "X-Broadcast-Token";
const CACHED_FIELDS = new Set(["full", "delta"]);

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 });
    }

    const response = await route(request, env, ctx);

    return request.method === "HEAD" ? new Response(null, response) : response;
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const origin = String(env.ORIGIN ?? "").replace(/\/+$/, "");

  if (url.pathname === "/health") {
    return Response.json({ ok: true, origin, version: VERSION });
  }

  if (!origin) {
    return new Response("ORIGIN is not configured", { status: 500 });
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const [matchId] = parts;

  if (!matchId) {
    return new Response(null, { status: 404 });
  }

  if (parts.length === 2 && parts[1] === "sync") {
    return sync(url, origin, matchId, ctx);
  }

  if (
    (parts.length === 3 || parts.length === 4) &&
    CACHED_FIELDS.has(parts[parts.length - 1])
  ) {
    return fragment(url, origin, parts, ctx);
  }

  return passThrough(`${origin}${url.pathname}${url.search}`);
}

async function sync(url, origin, matchId, ctx) {
  const key = new Request(url.toString());
  const cached = await caches.default.match(key);
  if (cached) {
    return cached;
  }

  const response = await fetch(`${origin}/${matchId}/sync${url.search}`);
  const result = await decoded(response, SYNC_CACHE_CONTROL);

  ctx.waitUntil(caches.default.put(key, result.clone()));

  return result;
}

async function fragment(url, origin, parts, ctx) {
  const [matchId] = parts;
  const [fragmentIndex, field] = parts.slice(-2);

  const token =
    parts.length === 4
      ? parts[1]
      : await broadcastToken(url, matchId, origin, ctx);

  if (!token) {
    return passThrough(`${origin}${url.pathname}${url.search}`);
  }

  const path = `/${matchId}/${token}/${fragmentIndex}/${field}`;
  const key = new Request(`${url.origin}${path}`);

  const scoped = parts.length === 4;

  const cached = await caches.default.match(key);
  if (cached) {
    return scoped ? cached : withCacheControl(cached, "no-store");
  }

  const response = await fetch(`${origin}${path}`);

  if (response.status !== 200) {
    return decoded(response, "no-store");
  }

  const result = await decoded(response, FRAGMENT_CACHE_CONTROL);

  ctx.waitUntil(caches.default.put(key, result.clone()));

  // Only the token-scoped url names this data forever. The same fragment
  // number without a token is a different fragment once a new map starts, so
  // nothing past this worker may keep it.
  return scoped ? result : withCacheControl(result, "no-store");
}

// Clients request fragments without the token, so it is read off the sync the
// panel serves (and this worker caches) for the match.
async function broadcastToken(url, matchId, origin, ctx) {
  const response = await sync(
    new URL(`${url.origin}/${matchId}/sync`),
    origin,
    matchId,
    ctx,
  );

  return response.headers.get(TOKEN_HEADER);
}

function withCacheControl(response, cacheControl) {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", cacheControl);
  return result;
}

async function passThrough(target) {
  return decoded(await fetch(target), "no-store");
}

// The panel gzips fragments, and fetch hands the worker the decoded body while
// keeping Content-Encoding. Passing that header on makes the runtime compress
// the body again on the way out of the cache, so viewers get it gzipped twice.
// Plain bytes are what Valve's relay serves and what CS2 reads.
async function decoded(response, cacheControl) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.set("Cache-Control", cacheControl);

  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
