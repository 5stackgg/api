jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import { MatchEventsGateway } from "./match-events.gateway";

function createGateway() {
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const hasura = { query: jest.fn(), mutation: jest.fn() };
  const cache = {
    has: jest.fn().mockResolvedValue(false),
    put: jest.fn().mockResolvedValue(undefined),
  };
  const mockProcessor = {
    setData: jest.fn(),
    process: jest.fn().mockResolvedValue(undefined),
  };
  const moduleRef = {
    resolve: jest.fn().mockResolvedValue(mockProcessor),
  };

  const gateway = new MatchEventsGateway(logger as any, moduleRef as any, hasura as any, cache as any);

  return { gateway, logger, hasura, cache, moduleRef, mockProcessor };
}

describe("MatchEventsGateway", () => {
  describe("handleConnection", () => {
    it("closes connection on invalid API password", async () => {
      const { gateway, hasura } = createGateway();
      const client = { close: jest.fn() } as any;
      const base64 = Buffer.from("server-1:wrong-pass").toString("base64");
      const request = { headers: { authorization: `Basic ${base64}` } } as any;

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: { id: "server-1", api_password: "correct" },
      });

      await gateway.handleConnection(client, request);

      expect(client.close).toHaveBeenCalled();
    });

    it("closes connection on auth exception", async () => {
      const { gateway, hasura } = createGateway();
      const client = { close: jest.fn() } as any;
      const base64 = Buffer.from("server-1:some-pass").toString("base64");
      const request = { headers: { authorization: `Basic ${base64}` } } as any;

      hasura.query.mockRejectedValueOnce(new Error("db error"));

      await gateway.handleConnection(client, request);

      expect(client.close).toHaveBeenCalled();
    });

    it("allows connection with valid credentials", async () => {
      const { gateway, hasura } = createGateway();
      const client = { close: jest.fn() } as any;
      const base64 = Buffer.from("server-1:correct-pass").toString("base64");
      const request = { headers: { authorization: `Basic ${base64}` } } as any;

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: { id: "server-1", api_password: "correct-pass" },
      });

      await gateway.handleConnection(client, request);

      expect(client.close).not.toHaveBeenCalled();
    });
  });

  describe("handleMatchEvent", () => {
    it("returns messageId immediately on duplicate (cache hit)", async () => {
      const { gateway, cache, moduleRef } = createGateway();

      cache.has.mockResolvedValueOnce(true);

      const result = await gateway.handleMatchEvent({
        matchId: "match-1",
        messageId: "msg-1",
        data: { event: "kill", data: {} },
      });

      expect(result).toBe("msg-1");
      expect(moduleRef.resolve).not.toHaveBeenCalled();
    });

    it("resolves processor and calls process for valid event", async () => {
      const { gateway, cache, moduleRef, mockProcessor } = createGateway();

      cache.has.mockResolvedValueOnce(false);

      const eventData = { attacker: "player-1", victim: "player-2" };

      const result = await gateway.handleMatchEvent({
        matchId: "match-1",
        messageId: "msg-2",
        data: { event: "kill", data: eventData },
      });

      expect(result).toBe("msg-2");
      expect(moduleRef.resolve).toHaveBeenCalled();
      expect(mockProcessor.setData).toHaveBeenCalledWith("match-1", eventData);
      expect(mockProcessor.process).toHaveBeenCalled();
    });
  });
});
