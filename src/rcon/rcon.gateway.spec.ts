jest.mock("@kubernetes/client-node", () => ({
  KubeConfig: jest.fn(),
  BatchV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
  Exec: jest.fn(),
}));

import { RconGateway } from "./rcon.gateway";

function createGateway() {
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
  };
  const rconService = {
    connect: jest.fn().mockResolvedValue(null),
  };

  const gateway = new RconGateway(hasura as any, rconService as any);

  return { gateway, hasura, rconService };
}

function makeClient(role: string, steamId = "76561198000000001") {
  return {
    user: { role, steam_id: steamId },
    send: jest.fn(),
  } as any;
}

describe("RconGateway", () => {
  describe("role-based access", () => {
    for (const role of ["user", "verified_user", "streamer"]) {
      it(`denies access for ${role} role`, async () => {
        const { gateway, rconService } = createGateway();
        const client = makeClient(role);

        await gateway.rconEvent(
          { uuid: "u1", command: "status", serverId: "s1" },
          client,
        );

        expect(rconService.connect).not.toHaveBeenCalled();
        expect(client.send).not.toHaveBeenCalled();
      });
    }

    it("denies access when client has no user", async () => {
      const { gateway, rconService } = createGateway();
      const client = { user: null, send: jest.fn() } as any;

      await gateway.rconEvent(
        { uuid: "u1", command: "status", serverId: "s1" },
        client,
      );

      expect(rconService.connect).not.toHaveBeenCalled();
    });
  });

  describe("administrator access", () => {
    it("allows administrator even when server has active match", async () => {
      const { gateway, hasura, rconService } = createGateway();
      const client = makeClient("administrator");
      const mockRcon = { send: jest.fn().mockResolvedValue("result") };

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: { current_match: { id: "m1" } },
      });
      rconService.connect.mockResolvedValueOnce(mockRcon);

      await gateway.rconEvent(
        { uuid: "u1", command: "status", serverId: "s1" },
        client,
      );

      // Administrator should NOT trigger the organizer check query
      expect(hasura.query).toHaveBeenCalledTimes(1);
      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining("result"),
      );
    });
  });

  describe("organizer access with active match", () => {
    it("allows organizer of active match", async () => {
      const { gateway, hasura, rconService } = createGateway();
      const client = makeClient("match_organizer");
      const mockRcon = { send: jest.fn().mockResolvedValue("ok") };

      hasura.query
        .mockResolvedValueOnce({
          servers_by_pk: { current_match: { id: "m1" } },
        })
        .mockResolvedValueOnce({
          matches_by_pk: { is_organizer: true },
        });
      rconService.connect.mockResolvedValueOnce(mockRcon);

      await gateway.rconEvent(
        { uuid: "u1", command: "status", serverId: "s1" },
        client,
      );

      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining("ok"),
      );
    });

    it("denies non-organizer when server has active match", async () => {
      const { gateway, hasura, rconService } = createGateway();
      const client = makeClient("match_organizer");

      hasura.query
        .mockResolvedValueOnce({
          servers_by_pk: { current_match: { id: "m1" } },
        })
        .mockResolvedValueOnce({
          matches_by_pk: { is_organizer: false },
        });

      await gateway.rconEvent(
        { uuid: "u1", command: "status", serverId: "s1" },
        client,
      );

      expect(rconService.connect).not.toHaveBeenCalled();
      expect(client.send).not.toHaveBeenCalled();
    });
  });

  describe("no active match", () => {
    it("allows non-admin role when server has no match", async () => {
      const { gateway, hasura, rconService } = createGateway();
      const client = makeClient("match_organizer");
      const mockRcon = { send: jest.fn().mockResolvedValue("output") };

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: { current_match: null },
      });
      rconService.connect.mockResolvedValueOnce(mockRcon);

      await gateway.rconEvent(
        { uuid: "u1", command: "mp_warmup_end", serverId: "s1" },
        client,
      );

      expect(client.send).toHaveBeenCalledWith(
        expect.stringContaining("output"),
      );
    });
  });

  describe("RCON connection failure", () => {
    it("sends error message when rcon connection fails", async () => {
      const { gateway, hasura, rconService } = createGateway();
      const client = makeClient("administrator");

      hasura.query.mockResolvedValueOnce({
        servers_by_pk: { current_match: null },
      });
      rconService.connect.mockResolvedValueOnce(null);

      await gateway.rconEvent(
        { uuid: "u1", command: "status", serverId: "s1" },
        client,
      );

      expect(client.send).toHaveBeenCalledWith(
        JSON.stringify({
          event: "rcon",
          data: {
            uuid: "u1",
            result: "unable to connect to rcon",
          },
        }),
      );
    });
  });
});
