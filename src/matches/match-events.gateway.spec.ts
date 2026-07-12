// Isolate the gateway from its heavy DI imports; we only exercise the
// dedup/processing ordering logic in handleMatchEvent.
jest.mock("./events", () => ({ MatchEvents: { testEvent: class {} } }));
jest.mock("src/hasura/hasura.service", () => ({ HasuraService: class {} }));
jest.mock("src/cache/cache.service", () => ({ CacheService: class {} }));

import { MatchEventsGateway } from "./match-events.gateway";

function makeGateway(opts: { cacheHit?: boolean; processImpl?: () => any }) {
  const cache = {
    has: jest.fn().mockResolvedValue(opts.cacheHit ?? false),
    put: jest.fn().mockResolvedValue(undefined),
  };
  const processor = {
    setData: jest.fn(),
    process: jest.fn().mockImplementation(opts.processImpl ?? (async () => {})),
  };
  const moduleRef = { resolve: jest.fn().mockResolvedValue(processor) };
  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
  };
  const gateway = new MatchEventsGateway(
    logger as any,
    moduleRef as any,
    {} as any,
    cache as any,
  );
  return { gateway, cache, processor, logger };
}

const message = {
  matchId: "match-1",
  messageId: "msg-1",
  data: { event: "testEvent", data: {} },
};

describe("MatchEventsGateway.handleMatchEvent dedup", () => {
  it("marks the event processed only after process() succeeds", async () => {
    const { gateway, cache, processor } = makeGateway({});
    const result = await gateway.handleMatchEvent(message as any);

    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    // Ordering: process resolved before the dedup entry was written.
    expect(processor.process.mock.invocationCallOrder[0]).toBeLessThan(
      cache.put.mock.invocationCallOrder[0],
    );
    expect(result).toBe("msg-1");
  });

  it("does NOT write the dedup entry when process() throws (so redelivery retries)", async () => {
    const { gateway, cache, processor } = makeGateway({
      processImpl: async () => {
        throw new Error("hasura down");
      },
    });

    await expect(gateway.handleMatchEvent(message as any)).rejects.toThrow(
      "hasura down",
    );
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("short-circuits on a dedup hit without processing", async () => {
    const { gateway, cache, processor } = makeGateway({ cacheHit: true });
    const result = await gateway.handleMatchEvent(message as any);

    expect(result).toBe("msg-1");
    expect(processor.process).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
