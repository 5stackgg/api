import http from "http";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { WebSocketAdapter } from "./web-socket.adapter";
import { isAllowedOrigin } from "../utilities/isAllowedOrigin";

describe("WebSocketAdapter", () => {
  let server: http.Server;
  let adapter: WebSocketAdapter;
  let port: number;

  const allowOrigin = isAllowedOrigin({
    origins: ["https://5stack.gg"],
    cookieDomain: ".5stack.gg",
  });

  beforeEach(async () => {
    server = http.createServer();
    adapter = new WebSocketAdapter(server, allowOrigin);

    for (const path of ["/ws/web", "/ws/matches"]) {
      adapter.create(0, { path }).on("connection", (client: WebSocket) => {
        client.close();
      });
    }

    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await adapter.dispose();
    await new Promise((resolve) => server.close(resolve));
  });

  const handshake = (path: string, origin?: string) =>
    new Promise<number>((resolve, reject) => {
      const client = new WebSocket(
        `ws://127.0.0.1:${port}${path}`,
        origin ? { origin } : {},
      );
      client.on("open", () => {
        client.terminate();
        resolve(101);
      });
      client.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
      client.on("error", reject);
    });

  it("refuses a /ws/web socket opened by another site, which the session cookie would sign in", async () => {
    expect(await handshake("/ws/web", "https://evil.example")).toBe(403);
    expect(await handshake("/ws/web", "https://evil-5stack.gg")).toBe(403);
    expect(await handshake("/ws/web", "http://dev.5stack.gg")).toBe(403);
  });

  it("refuses a /ws/web socket with no Origin, since only browsers open one", async () => {
    expect(await handshake("/ws/web")).toBe(403);
  });

  it("lets the panel and its own subdomains open /ws/web", async () => {
    expect(await handshake("/ws/web", "https://5stack.gg")).toBe(101);
    expect(await handshake("/ws/web", "https://dev.5stack.gg")).toBe(101);
  });

  it("leaves the game servers' /ws/matches socket alone", async () => {
    expect(await handshake("/ws/matches")).toBe(101);
    expect(await handshake("/ws/matches", "https://evil.example")).toBe(101);
  });
});
