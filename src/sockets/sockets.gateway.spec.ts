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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("answers an anonymous client without touching its presence", async () => {
    const anonymous = client();

    await gateway.handleMessage(anonymous);

    expect(JSON.parse(anonymous.send.mock.calls[0][0]).event).toBe("pong");
    expect(sockets.heartbeat).not.toHaveBeenCalled();
  });

  it("answers a signed-in client and refreshes its presence", async () => {
    const signedIn = client({ user: { steam_id: "76561198000000001" } });

    await gateway.handleMessage(signedIn);

    expect(JSON.parse(signedIn.send.mock.calls[0][0]).event).toBe("pong");
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

  it("tells the web the api's time and when its ping left", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const anonymous = client();

    await gateway.handleMessage(anonymous, { sentAt: 1_799_999_999_950 });

    expect(JSON.parse(anonymous.send.mock.calls[0][0])).toEqual({
      event: "pong",
      data: { serverNow: 1_800_000_000_000, sentAt: 1_799_999_999_950 },
    });
  });

  it("echoes no ping time it cannot read as one", async () => {
    const anonymous = client();

    await gateway.handleMessage(anonymous, { sentAt: "soon" } as any);
    await gateway.handleMessage(anonymous);

    for (const [sent] of anonymous.send.mock.calls) {
      expect(JSON.parse(sent).data).not.toHaveProperty("sentAt");
    }
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
