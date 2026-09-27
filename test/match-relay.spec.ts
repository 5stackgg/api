import { PassThrough } from "stream";
import { gunzipSync } from "zlib";
import { Logger } from "@nestjs/common";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { MatchRelayService } from "../src/matches/match-relay/match-relay.service";

const fakeResponse = () => {
  let resolveEnded: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  const response = {
    statusCode: undefined as number | undefined,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    headersSent: false,
    ended,
    writeHead(code: number, headers?: unknown) {
      response.statusCode = code;
      response.headersSent = true;
      if (headers && typeof headers === "object") {
        Object.assign(response.headers, headers);
      }
      return response;
    },
    setHeader(name: string, value: unknown) {
      response.headers[name] = value;
    },
    end(body?: unknown) {
      response.body = body;
      resolveEnded();
      return response;
    },
  };

  return response;
};

// Runs against a real redis, like production: the relay's correctness is in
// what survives in redis between requests, which a mock cannot show.
describe("MatchRelayService", () => {
  const matchId = "match-1";
  const token = "s845489096165654t8799308478907";

  let container: StartedTestContainer;
  let redis: Redis;
  let service: MatchRelayService;

  const newService = () =>
    new MatchRelayService(new Logger("MatchRelayTest"), {
      getConnection: () => redis,
    } as any);

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });
  }, 120_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
    service = newService();
  });

  const openPost = (
    field: "start" | "full" | "delta",
    fragment: number,
    query: Record<string, string> = {},
    postToken = token,
    relay = service,
  ) => {
    const request = Object.assign(new PassThrough(), { query });
    const response = fakeResponse();

    const done = relay.postField(
      request as any,
      response as any,
      postToken,
      field,
      matchId,
      fragment,
    );

    return {
      finish: async (body = `${field}-${fragment}`) => {
        request.end(Buffer.from(body));
        await done;
        await response.ended;
        return response;
      },
    };
  };

  const post = (
    field: "start" | "full" | "delta",
    fragment: number,
    query: Record<string, string> = {},
    postToken = token,
    relay = service,
  ) => openPost(field, fragment, query, postToken, relay).finish();

  const sync = async (query: Record<string, string> = {}, relay = service) => {
    const response = fakeResponse();
    await relay.getSyncInfo({ query } as any, response as any, matchId);
    return response;
  };

  const getStart = async (fragment: number) => {
    const response = fakeResponse();
    await service.getStart(response as any, matchId, fragment);
    return response;
  };

  const getFragment = async (
    fragment: number,
    field: "full" | "delta",
    fragmentToken?: string,
    relay = service,
  ) => {
    const response = fakeResponse();
    await relay.getFragment(
      response as any,
      matchId,
      fragment,
      field,
      fragmentToken,
    );
    return response;
  };

  const startBroadcastAt = async (fragment: number, postToken = token) => {
    await post(
      "start",
      fragment,
      {
        tick: "100",
        tps: "64",
        map: "de_inferno",
        keyframe_interval: "3",
        protocol: "5",
      },
      postToken,
    );
    await post("full", fragment, { tick: "100" }, postToken);
    await post("delta", fragment, { endtick: "292" }, postToken);
  };

  const postFragments = async (from: number, to: number) => {
    for (let fragment = from; fragment <= to; fragment++) {
      await post("full", fragment, { tick: String(fragment * 192) });
      await post("delta", fragment, { endtick: String(fragment * 192 + 192) });
    }
  };

  it("reports the fragment the broadcast signed up at, with numeric fields", async () => {
    await startBroadcastAt(42);

    const response = await sync({ fragment: "0" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual(
      expect.objectContaining({
        fragment: 42,
        signup_fragment: 42,
        tick: 100,
        endtick: 292,
        maxtick: 292,
        tps: 64,
        keyframe_interval: 3,
        map: "de_inferno",
        protocol: 5,
      }),
    );
  });

  it("starts a new client 7 fragments behind the newest", async () => {
    await startBroadcastAt(42);
    await postFragments(43, 52);

    const body = JSON.parse((await sync()).body as string);

    expect(body.fragment).toBe(45);
  });

  it("tells a proxy which broadcast the sync belongs to", async () => {
    await startBroadcastAt(42);

    expect((await sync()).headers["X-Broadcast-Token"]).toBe(token);
  });

  it("reports how long clients keep playing once the server stops posting", async () => {
    await startBroadcastAt(42);

    // Clients sit 7 fragments behind the newest and still have that one to play.
    expect(await service.playoutSeconds(matchId)).toBe(8 * 3);
  });

  it("has nothing to play out for a broadcast it does not hold", async () => {
    expect(await service.playoutSeconds(matchId)).toBe(0);
  });

  // CS2 sends tps as a decimal (64.0), not an integer, so the coercion has to
  // accept a fractional part or clients get tps back as a string.
  it("reports a fractional tps as a number", async () => {
    await post("start", 42, { tick: "100", tps: "64.0", map: "de_inferno" });
    await post("full", 42, { tick: "100" });
    await post("delta", 42, { endtick: "292" });

    const response = await sync({ fragment: "0" });

    expect(JSON.parse(response.body as string)).toEqual(
      expect.objectContaining({ tps: 64 }),
    );
  });

  it("keeps fields that are not numeric in /sync as the strings the server sent", async () => {
    await post("start", 42, {
      tick: "100",
      tps: "64",
      map: "3070284539",
      protocol: "5",
    });
    await post("full", 42, { tick: "100" });
    await post("delta", 42, { endtick: "292" });

    const body = JSON.parse((await sync({ fragment: "0" })).body as string);

    expect(body.map).toBe("3070284539");
    expect(body.tick).toBe(100);
  });

  it("serves start only at the fragment the broadcast signed up at", async () => {
    await startBroadcastAt(42);

    expect((await getStart(42)).statusCode).toBe(200);
    expect((await getStart(0)).statusCode).toBe(404);
  });

  it("moves the signup fragment when the game server re-sends start", async () => {
    await startBroadcastAt(42);
    await post("start", 50, { tick: "900", tps: "64", map: "de_inferno" });

    expect((await getStart(50)).statusCode).toBe(200);
    expect((await getStart(42)).statusCode).toBe(404);
  });

  it("asks for start again when a fragment arrives before any start", async () => {
    const response = await post("full", 7, { tick: "100" });

    expect(response.statusCode).toBe(205);
  });

  it("asks for start again when a fragment arrives before the start data has", async () => {
    const start = openPost("start", 42, { tick: "100", tps: "64" });

    const early = await post("full", 42, { tick: "100" });
    expect(early.statusCode).toBe(205);

    await start.finish();

    const late = await post("full", 43, { tick: "292" });
    expect(late.statusCode).toBe(200);
  });

  it("serves the posted fragment back, gzipped", async () => {
    await startBroadcastAt(42);

    const response = await getFragment(42, "full");

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Encoding"]).toBe("gzip");
    expect(gunzipSync(response.body as Buffer).toString()).toBe("full-42");
  });

  it("keeps a broadcast going across an api restart", async () => {
    await startBroadcastAt(42);
    await postFragments(43, 52);

    const restarted = newService();

    expect((await sync({}, restarted)).statusCode).toBe(200);
    expect(
      (await getFragment(50, "delta", undefined, restarted)).statusCode,
    ).toBe(200);
    expect(
      (await post("full", 53, { tick: "1" }, token, restarted)).statusCode,
    ).toBe(200);
  });

  it("drops the old broadcast's fragments when a new broadcast starts", async () => {
    await startBroadcastAt(42);
    await postFragments(43, 45);

    const nextToken = "s845489096165654t1111111111111";
    await startBroadcastAt(3, nextToken);

    expect((await getFragment(44, "full")).statusCode).toBe(404);
    expect((await getFragment(3, "full")).statusCode).toBe(200);
    expect((await sync()).headers["X-Broadcast-Token"]).toBe(nextToken);
  });

  it("lets a fragment under the current token be cached for good", async () => {
    await startBroadcastAt(42);

    const scoped = await getFragment(42, "full", token);
    expect(scoped.statusCode).toBe(200);
    expect(scoped.headers["Cache-Control"]).toContain("immutable");

    const unscoped = await getFragment(42, "full");
    expect(unscoped.headers["Cache-Control"]).toBeUndefined();
  });

  it("refuses a fragment under an old token, uncached", async () => {
    await startBroadcastAt(42);

    const stale = await getFragment(42, "full", "s1t2");

    expect(stale.statusCode).toBe(404);
    expect(stale.headers["Cache-Control"]).toBe("no-store");
  });

  it("does not cache a fragment that has not arrived yet", async () => {
    await startBroadcastAt(42);

    const missing = await getFragment(43, "full", token);

    expect(missing.statusCode).toBe(404);
    expect(missing.headers["Cache-Control"]).toBe("no-store");
  });

  it("forgets everything about a removed broadcast", async () => {
    await startBroadcastAt(42);
    await postFragments(43, 45);

    await service.removeBroadcast(matchId);

    expect((await sync()).statusCode).toBe(404);
    expect((await getFragment(44, "full")).statusCode).toBe(404);
    expect(await service.playoutSeconds(matchId)).toBe(0);
    expect(await redis.keys(`match-relay:${matchId}:*`)).toEqual([]);
  });

  it("lets fragments expire a minute after they arrive", async () => {
    await startBroadcastAt(42);

    const ttl = await redis.ttl(`match-relay:${matchId}:${token}:fragment:42`);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("keeps the start of a broadcast alive for as long as fragments arrive", async () => {
    await startBroadcastAt(42);
    const startKey = `match-relay:${matchId}:${token}:start`;
    await redis.expire(startKey, 5);

    await postFragments(43, 43);

    expect(await redis.ttl(startKey)).toBeGreaterThan(3000);
  });

  it("does not tell the game server a fragment was stored when it was not", async () => {
    await startBroadcastAt(42);
    await redis.set(
      `match-relay:${matchId}:${token}:fragment:43`,
      "not a hash",
    );

    const request = Object.assign(new PassThrough(), { query: { tick: "1" } });
    const response = fakeResponse();
    const done = service.postField(
      request as any,
      response as any,
      token,
      "full",
      matchId,
      43,
    );
    request.end(Buffer.from("full-43"));

    await expect(done).rejects.toThrow();
    expect(response.statusCode).toBeUndefined();
  });

  it("never reads an old broadcast's data under the new one's token", async () => {
    await startBroadcastAt(42);
    await postFragments(43, 45);

    const nextToken = "s845489096165654t1111111111111";
    await startBroadcastAt(3, nextToken);

    expect(await redis.keys(`match-relay:${matchId}:${token}:*`)).toEqual([]);
    expect((await getFragment(44, "full", nextToken)).statusCode).toBe(404);
  });
});
