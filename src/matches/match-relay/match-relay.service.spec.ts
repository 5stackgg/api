import { EventEmitter } from "events";
import { MatchRelayService } from "./match-relay.service";

const fakeResponse = () => {
  let resolveEnded: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  const response = {
    statusCode: undefined as number | undefined,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    ended,
    writeHead(code: number, headers?: unknown) {
      response.statusCode = code;
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

describe("MatchRelayService", () => {
  const matchId = "match-1";
  const token = "s845489096165654t8799308478907";

  let service: MatchRelayService;

  beforeEach(() => {
    service = new MatchRelayService({
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any);
  });

  const openPost = (
    field: "start" | "full" | "delta",
    fragment: number,
    query: Record<string, string> = {},
  ) => {
    const request = Object.assign(new EventEmitter(), { query });
    const response = fakeResponse();

    service.postField(
      request as any,
      response as any,
      token,
      field,
      matchId,
      fragment,
    );

    return {
      response,
      finish: async () => {
        request.emit("data", Buffer.from(`${field}-${fragment}`));
        request.emit("end");
        await response.ended;
        return response;
      },
    };
  };

  const post = (
    field: "start" | "full" | "delta",
    fragment: number,
    query: Record<string, string> = {},
  ) => openPost(field, fragment, query).finish();

  const sync = (query: Record<string, string> = {}) => {
    const response = fakeResponse();
    service.getSyncInfo({ query } as any, response as any, matchId);
    return response;
  };

  const getStart = (fragment: number) => {
    const response = fakeResponse();
    service.getStart(response as any, matchId, fragment);
    return response;
  };

  const startBroadcastAt = async (fragment: number) => {
    await post("start", fragment, {
      tick: "100",
      tps: "64",
      map: "de_inferno",
      keyframe_interval: "3",
      protocol: "5",
    });
    await post("full", fragment, { tick: "100" });
    await post("delta", fragment, { endtick: "292" });
  };

  it("reports the fragment the broadcast signed up at, with numeric fields", async () => {
    await startBroadcastAt(42);

    const response = sync({ fragment: "0" });

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

  it("serves start only at the fragment the broadcast signed up at", async () => {
    await startBroadcastAt(42);

    expect(getStart(42).statusCode).toBe(200);
    expect(getStart(0).statusCode).toBe(404);
  });

  it("moves the signup fragment when the game server re-sends start", async () => {
    await startBroadcastAt(42);
    await post("start", 50, { tick: "900", tps: "64", map: "de_inferno" });

    expect(getStart(50).statusCode).toBe(200);
    expect(getStart(42).statusCode).toBe(404);
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
});
