import { BadRequestException } from "@nestjs/common";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { FileManagerService } from "./file-manager.service";

// Nest builds an HttpException's message from the response only when it is a
// string; anything else falls back to the class name, so the operator is told
// "Bad Request Exception" and nothing about what they did wrong.
describe("FileManagerService.connectorErrorMessage", () => {
  const message = (error: unknown) =>
    new BadRequestException(FileManagerService.connectorErrorMessage(error))
      .message;

  it("flattens the array the connector's ValidationPipe returns", () => {
    expect(
      FileManagerService.connectorErrorMessage({
        statusCode: 400,
        message: [
          "destPath must be a string",
          "sourcePath should not be empty",
        ],
        error: "Bad Request",
      }),
    ).toBe("destPath must be a string, sourcePath should not be empty");
  });

  it("passes a plain string through", () => {
    expect(
      FileManagerService.connectorErrorMessage({
        message: "Destination already exists: addons",
      }),
    ).toBe("Destination already exists: addons");
  });

  // A proxy in front of the connector answers in its own shape, and an object
  // reaching BadRequestException reads as "Bad Request Exception".
  it("flattens a message that is not a string at all", () => {
    expect(message({ message: { error: "path traversal detected" } })).toBe(
      '{"error":"path traversal detected"}',
    );
    expect(message({ message: 400 })).toBe("400");
  });

  it("gives an empty string when there is no message to report", () => {
    expect(FileManagerService.connectorErrorMessage({})).toBe("");
    expect(FileManagerService.connectorErrorMessage(undefined)).toBe("");
    expect(FileManagerService.connectorErrorMessage({ message: null })).toBe(
      "",
    );
  });

  it("survives the round trip into an exception the operator reads", () => {
    expect(message({ message: ["destPath must be a string"] })).toBe(
      "destPath must be a string",
    );
  });
});

describe("FileManagerService.relayServerDirectory", () => {
  const archive = Buffer.alloc(256 * 1024, 7);
  let servers: Array<http.Server>;
  let service: FileManagerService;
  let received: { headers: http.IncomingHttpHeaders; bytes: number };
  let sourceHandler: http.RequestListener;
  let targetHandler: http.RequestListener;

  const listen = async (handler: () => http.RequestListener) => {
    const server = http.createServer((req, res) => handler()(req, res));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return (server.address() as AddressInfo).port;
  };

  const relay = (signal = new AbortController().signal) => {
    const progress: Array<number> = [];

    return {
      progress,
      result: service.relayServerDirectory("node-a", "node-b", "server-1", {
        signal,
        onProgress: (done) => progress.push(done),
      }),
    };
  };

  beforeEach(async () => {
    servers = [];
    received = { headers: {}, bytes: 0 };
    service = new FileManagerService(
      { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as never,
      null as never,
      null as never,
    );

    sourceHandler = (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/x-tar",
        "x-5stack-entries": "12",
        "x-5stack-bytes": "4096",
        "x-5stack-archive-bytes": String(archive.length),
      });
      res.end(archive);
    };
    targetHandler = (req, res) => {
      received.headers = req.headers;
      req.on("data", (chunk) => (received.bytes += chunk.length));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, entries: 12, bytes: 4096 }));
      });
    };

    const ports: Record<string, number> = {
      "node-a": await listen(() => sourceHandler),
      "node-b": await listen(() => targetHandler),
    };

    jest
      .spyOn(service as any, "connectorAddress")
      .mockImplementation(async (nodeId: string) => ({
        host: "127.0.0.1",
        port: ports[nodeId],
      }));
  });

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      ),
    );
  });

  it("streams the source node's archive into the target node", async () => {
    const { result, progress } = relay();

    await expect(result).resolves.toEqual({ entries: 12, bytes: 4096 });

    expect(received.bytes).toBe(archive.length);
    expect(received.headers).toMatchObject({
      "content-type": "application/x-tar",
      "x-5stack-expected-entries": "12",
      "x-5stack-expected-bytes": "4096",
    });
    expect(progress.at(-1)).toBe(archive.length);
  });

  it("reports why the target node refused the files", async () => {
    let sourceClosed = false;

    sourceHandler = (req, res) => {
      res.writeHead(200, {
        "x-5stack-entries": "12",
        "x-5stack-bytes": "4096",
      });
      res.write(archive);
      req.socket.on("close", () => (sourceClosed = true));
    };
    targetHandler = (_req, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "archive is incomplete" }));
    };

    await expect(relay().result).rejects.toThrow("archive is incomplete");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sourceClosed).toBe(true);
  });

  it("tells the operator to update a connector that does not know the route", async () => {
    sourceHandler = (_req, res) => {
      res.writeHead(404);
      res.end("{}");
    };

    await expect(relay().result).rejects.toThrow(/node-a is out of date/);
  });

  it("drops both connections when the move is canceled", async () => {
    const abort = new AbortController();
    let targetClosed = false;

    sourceHandler = (_req, res) => {
      res.writeHead(200, {
        "x-5stack-entries": "12",
        "x-5stack-bytes": "4096",
      });
      res.write(archive);
      setTimeout(() => abort.abort(new Error("The move was canceled")), 20);
    };
    targetHandler = (req) => {
      req.resume();
      req.socket.on("close", () => (targetClosed = true));
    };

    await expect(relay(abort.signal).result).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(targetClosed).toBe(true);
  });
});
