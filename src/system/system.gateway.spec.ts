import { PassThrough } from "stream";
import { SystemGateway } from "./system.gateway.ts";

describe("SystemGateway logs", () => {
  let streams: Array<PassThrough>;
  let gateway: SystemGateway;

  const client = () =>
    ({
      authentication: Promise.resolve(),
      user: { steam_id: "1", name: "Luke", role: "administrator" },
      send: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    }) as any;

  beforeEach(() => {
    streams = [];
    gateway = new SystemGateway(
      { warn: jest.fn() } as any,
      {
        getServiceLogs: jest.fn(async (_service, stream: PassThrough) => {
          streams.push(stream);
        }),
      } as any,
    );
  });

  it("stops the stream for the service it names", async () => {
    const socket = client();
    await gateway.logEvent({ service: "api" }, socket);

    await gateway.stopLogs({ service: "api" }, socket);

    expect(streams[0].destroyed).toBe(true);
    expect(socket.removeListener).toHaveBeenCalledWith(
      "close",
      socket.on.mock.calls[0][1],
    );
  });

  it("stops whatever is streaming when no service is named", async () => {
    const socket = client();
    await gateway.logEvent({ service: "api" }, socket);

    await gateway.stopLogs(undefined, socket);

    expect(streams[0].destroyed).toBe(true);
  });

  it("leaves a newer stream for another service running", async () => {
    const socket = client();
    await gateway.logEvent({ service: "api" }, socket);
    await gateway.logEvent({ service: "web" }, socket);

    await gateway.stopLogs({ service: "api" }, socket);

    expect(streams[0].destroyed).toBe(true);
    expect(streams[1].destroyed).toBe(false);

    await gateway.stopLogs({ service: "web" }, socket);
    expect(streams[1].destroyed).toBe(true);
  });

  it("does nothing without a stream, and streams again after a stop", async () => {
    const socket = client();
    await gateway.stopLogs({ service: "api" }, socket);

    await gateway.logEvent({ service: "api" }, socket);
    await gateway.stopLogs({ service: "api" }, socket);
    await gateway.logEvent({ service: "api" }, socket);

    expect(streams).toHaveLength(2);
    expect(streams[0].destroyed).toBe(true);
    expect(streams[1].destroyed).toBe(false);
  });

  it("ignores a stop from below administrator", async () => {
    const socket = client();
    await gateway.logEvent({ service: "api" }, socket);

    socket.user.role = "moderator";
    await gateway.stopLogs({ service: "api" }, socket);

    expect(streams[0].destroyed).toBe(false);
  });

  it("keeps every requested service live at once", async () => {
    const socket = client();
    await gateway.logEvent({ service: "api" }, socket);
    await gateway.logEvent({ service: "hasura" }, socket);
    await gateway.logEvent({ service: "redis" }, socket);

    expect(streams.map((stream) => stream.destroyed)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("replaces only that service's stream when it is asked for again", async () => {
    const socket = client();
    await gateway.logEvent({ service: "api" }, socket);
    await gateway.logEvent({ service: "hasura" }, socket);
    await gateway.logEvent({ service: "api" }, socket);

    expect(streams.map((stream) => stream.destroyed)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("loads an earlier window without ending the live stream", async () => {
    const socket = client();
    await gateway.logEvent({ service: "api" }, socket);
    await gateway.logEvent(
      {
        service: "api",
        since: { start: "2026-10-17T20:00:00Z", until: "2026-10-17T21:00:00Z" },
      },
      socket,
    );

    expect(streams.map((stream) => stream.destroyed)).toEqual([false, false]);

    await gateway.stopLogs({ service: "api" }, socket);
    expect(streams.map((stream) => stream.destroyed)).toEqual([true, true]);
  });

  it("stops the oldest stream once a socket holds too many", async () => {
    const socket = client();
    for (let i = 0; i < 17; i++) {
      await gateway.logEvent({ service: `svc-${i}` }, socket);
    }

    expect(streams[0].destroyed).toBe(true);
    expect(streams.slice(1).every((stream) => !stream.destroyed)).toBe(true);
  });

  it("stops every stream when no service is named", async () => {
    const socket = client();
    await gateway.logEvent({ service: "api" }, socket);
    await gateway.logEvent({ service: "hasura" }, socket);

    await gateway.stopLogs(undefined, socket);

    expect(streams.every((stream) => stream.destroyed)).toBe(true);
  });
});
