import { SignalServerGateway } from "./signal-server.gateway";

const USER = { steam_id: "76561198000000001", name: "Luke", role: "user" };

function makeGateway(nodes: Record<string, string> = { US: "node-us" }) {
  const hasura = {
    query: jest.fn(async (query: any) => {
      const region = query.game_server_nodes.__args.where.region._eq;
      return {
        game_server_nodes: nodes[region] ? [{ id: nodes[region] }] : [],
      };
    }),
  };
  const nodeClient = { emit: jest.fn() };
  const gateway = new SignalServerGateway(hasura as any, nodeClient as any);

  return { gateway, hasura, nodeClient };
}

function socket(id: string, user: typeof USER | null = USER) {
  return {
    id,
    user,
    sessionId: `session-${id}`,
    peerNodes: new Set<string>(),
    signalPeers: new Map(),
    authentication: Promise.resolve(),
  } as any;
}

const offer = (peerId: string, region = "US") => ({
  region,
  peerId,
  signal: { type: "offer", sdp: "v=0" } as any,
});

const candidate = (peerId: string, region = "US") => ({
  region,
  peerId,
  signal: { type: "candidate", candidate: { candidate: "c" } } as any,
});

describe("SignalServerGateway", () => {
  it("relays an offer and its candidates to the region's node", async () => {
    const { gateway, nodeClient } = makeGateway();
    const client = socket("client-a");

    await Promise.all([
      gateway.handleOffer(offer("peer-1"), client),
      gateway.handleIceCandidate(candidate("peer-1"), client),
    ]);

    expect(nodeClient.emit.mock.calls.map(([pattern]) => pattern)).toEqual([
      "offer.node-us",
      "candidate.node-us",
    ]);
    expect(nodeClient.emit).toHaveBeenCalledWith("offer.node-us", {
      region: "US",
      signal: offer("peer-1").signal,
      peerId: "peer-1",
      clientId: "client-a",
      sessionId: "session-client-a",
    });
    expect(client.peerNodes).toEqual(new Set(["node-us"]));
  });

  it("refuses an unauthenticated client", async () => {
    const { gateway, hasura, nodeClient } = makeGateway();
    const client = socket("client-a", null);

    await gateway.handleOffer(offer("peer-1"), client);
    await gateway.handleIceCandidate(candidate("peer-1"), client);

    expect(hasura.query).not.toHaveBeenCalled();
    expect(nodeClient.emit).not.toHaveBeenCalled();
  });

  it("refuses a candidate for a peer another socket offered", async () => {
    const { gateway, nodeClient } = makeGateway();
    const owner = socket("client-a");
    const other = socket("client-b");

    await gateway.handleOffer(offer("peer-1"), owner);
    nodeClient.emit.mockClear();

    await gateway.handleIceCandidate(candidate("peer-1"), other);

    expect(nodeClient.emit).not.toHaveBeenCalled();
  });

  it("refuses a candidate for a peer that was never offered", async () => {
    const { gateway, hasura, nodeClient } = makeGateway();

    await gateway.handleIceCandidate(candidate("peer-1"), socket("client-a"));

    expect(hasura.query).not.toHaveBeenCalled();
    expect(nodeClient.emit).not.toHaveBeenCalled();
  });

  it("sends a candidate to the node its offer went to", async () => {
    const { gateway, nodeClient } = makeGateway({
      US: "node-us",
      EU: "node-eu",
    });
    const client = socket("client-a");

    await gateway.handleOffer(offer("peer-1", "US"), client);
    await gateway.handleIceCandidate(candidate("peer-1", "EU"), client);

    expect(nodeClient.emit).toHaveBeenLastCalledWith(
      "candidate.node-us",
      expect.objectContaining({ peerId: "peer-1", clientId: "client-a" }),
    );
  });

  it("forgets a socket's oldest peers past thirty-two", async () => {
    const { gateway, nodeClient } = makeGateway();
    const client = socket("client-a");

    for (let peer = 0; peer <= 32; peer++) {
      await gateway.handleOffer(offer(`peer-${peer}`), client);
    }
    nodeClient.emit.mockClear();

    await gateway.handleIceCandidate(candidate("peer-0"), client);
    await gateway.handleIceCandidate(candidate("peer-32"), client);

    expect(client.signalPeers.size).toBe(32);
    expect(nodeClient.emit).toHaveBeenCalledTimes(1);
    expect(nodeClient.emit).toHaveBeenCalledWith(
      "candidate.node-us",
      expect.objectContaining({ peerId: "peer-32" }),
    );
  });

  it("relays nothing for a region without an online node", async () => {
    const { gateway, nodeClient } = makeGateway({});
    const client = socket("client-a");

    await gateway.handleOffer(offer("peer-1"), client);
    await gateway.handleIceCandidate(candidate("peer-1"), client);

    expect(nodeClient.emit).not.toHaveBeenCalled();
    expect(client.peerNodes.size).toBe(0);
  });

  it.each([
    ["a missing payload", undefined],
    ["a region that is not a string", { ...offer("peer-1"), region: 1 }],
    ["a peer id that is not a string", { ...offer("peer-1"), peerId: {} }],
  ])("ignores an offer with %s", async (_, data) => {
    const { gateway, hasura, nodeClient } = makeGateway();

    await gateway.handleOffer(data as any, socket("client-a"));

    expect(hasura.query).not.toHaveBeenCalled();
    expect(nodeClient.emit).not.toHaveBeenCalled();
  });
});
