import { SocketsGateway } from "./sockets.gateway";

describe("SocketsGateway ping", () => {
  let gateway: SocketsGateway;
  let sockets: { heartbeat: jest.Mock };

  const OPEN = 1;
  const CLOSED = 3;

  const client = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "client-1",
      user: undefined,
      readyState: OPEN,
      OPEN,
      send: jest.fn(),
      ...overrides,
    }) as any;

  beforeEach(() => {
    sockets = { heartbeat: jest.fn().mockResolvedValue(undefined) };
    gateway = new SocketsGateway(sockets as any);
  });

  it("answers an anonymous client without touching its presence", async () => {
    const anonymous = client();

    await gateway.handleMessage(anonymous);

    expect(anonymous.send).toHaveBeenCalledWith(
      JSON.stringify({ event: "pong" }),
    );
    expect(sockets.heartbeat).not.toHaveBeenCalled();
  });

  it("answers a signed-in client and refreshes its presence", async () => {
    const signedIn = client({ user: { steam_id: "76561198000000001" } });

    await gateway.handleMessage(signedIn);

    expect(signedIn.send).toHaveBeenCalledWith(
      JSON.stringify({ event: "pong" }),
    );
    expect(sockets.heartbeat).toHaveBeenCalledWith(
      "76561198000000001",
      "client-1",
    );
  });

  it("sends the pong before presence is written", async () => {
    let sentBeforeUpdate = false;
    const signedIn = client({ user: { steam_id: "76561198000000001" } });
    sockets.heartbeat.mockImplementation(async () => {
      sentBeforeUpdate = signedIn.send.mock.calls.length > 0;
    });

    await gateway.handleMessage(signedIn);

    expect(sentBeforeUpdate).toBe(true);
  });

  it("sends nothing to a socket that is no longer open", async () => {
    const closing = client({
      readyState: CLOSED,
      user: { steam_id: "76561198000000001" },
    });

    await gateway.handleMessage(closing);

    expect(closing.send).not.toHaveBeenCalled();
  });
});
