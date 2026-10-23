import http from "http";
import { AddressInfo } from "net";
import { randomBytes } from "crypto";
import { Client } from "pg";
import WebSocket from "ws";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";

// The engine production runs: 5stack-panel base/hasura/deployment.yaml.
const IMAGE =
  "hasura/graphql-engine:v2.50.5-ce.cli-migrations-v3@sha256:4955dba48e3c1a814cfaaf1951219f23661dcd846c00be04c4fc54949069d34d";
const ADMIN_SECRET = "hasura-socket-sessions";
const INSERT = "mutation { insert_session_probe_one(object: {}) { role } }";

type Protocol = "graphql-transport-ws" | "graphql-ws";
type Socket = {
  ws: WebSocket;
  protocol: Protocol;
  messages: Array<any>;
  closed: Promise<number>;
};

// Hasura asks the auth hook (GET /hasura) once per socket, on connection_init,
// and once per HTTP request. These pin what the engine does with a max-age in
// the hook's answer.
describe("Hasura auth hook sessions", () => {
  const database = `test_hasura_socket_sessions_${randomBytes(4).toString("hex")}`;
  const connection = {
    host: process.env.SQL_TEST_HOST!,
    port: Number(process.env.SQL_TEST_PORT),
    user: process.env.SQL_TEST_USER!,
    password: process.env.SQL_TEST_PASSWORD!,
  };
  const answers = new Map<string, Record<string, string>>();
  const calls = new Map<string, number>();
  const sockets: Array<Socket> = [];
  let hook: http.Server;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let opId = 0;

  async function maintenance(sql: string) {
    const admin = new Client({ ...connection, database: "postgres" });
    await admin.connect();
    try {
      await admin.query(sql);
    } finally {
      await admin.end();
    }
  }

  beforeAll(async () => {
    await maintenance(`CREATE DATABASE "${database}"`);
    const db = new Client({ ...connection, database });
    await db.connect();
    await db.query(
      "CREATE TABLE session_probe (id serial PRIMARY KEY, role text, user_id text)",
    );
    await db.end();

    hook = http.createServer((request, response) => {
      const player = String(request.headers["x-test-player"] ?? "");
      calls.set(player, (calls.get(player) ?? 0) + 1);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          answers.get(player) ?? {
            "x-hasura-role": "guest",
            "x-hasura-user-id": "0",
          },
        ),
      );
    });
    await new Promise<void>((resolve) => hook.listen(0, "0.0.0.0", resolve));
    const hookPort = (hook.address() as AddressInfo).port;

    hasura = await new GenericContainer(IMAGE)
      .withExtraHosts([
        { host: "host.docker.internal", ipAddress: "host-gateway" },
      ])
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: `postgres://${connection.user}:${connection.password}@host.docker.internal:${connection.port}/${database}`,
        HASURA_GRAPHQL_ADMIN_SECRET: ADMIN_SECRET,
        HASURA_GRAPHQL_AUTH_HOOK: `http://host.docker.internal:${hookPort}/hasura`,
        HASURA_GRAPHQL_ENABLE_TELEMETRY: "false",
      })
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .start();
    endpoint = `${hasura.getHost()}:${hasura.getMappedPort(8080)}`;

    const permissions = ["administrator", "user"].flatMap((role) => [
      {
        type: "pg_create_insert_permission",
        args: {
          table: "session_probe",
          role,
          permission: {
            check: {},
            columns: [] as Array<string>,
            set: { role: "X-Hasura-Role", user_id: "X-Hasura-User-Id" },
          },
        },
      },
      {
        type: "pg_create_select_permission",
        args: {
          table: "session_probe",
          role,
          permission: { filter: {}, columns: ["id", "role", "user_id"] },
        },
      },
    ]);
    const tracked = await fetch(`http://${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": ADMIN_SECRET,
      },
      body: JSON.stringify({
        type: "bulk",
        args: [
          { type: "pg_track_table", args: { table: "session_probe" } },
          ...permissions,
        ],
      }),
    });
    expect(tracked.status).toBe(200);
  }, 300_000);

  afterAll(async () => {
    for (const socket of sockets) {
      socket.ws.terminate();
    }
    await hasura?.stop();
    await new Promise((resolve) => hook?.close(resolve));
    await maintenance(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  });

  function answer(player: string, role: string, extra = {}) {
    answers.set(player, {
      "x-hasura-role": role,
      "x-hasura-user-id": player,
      ...extra,
    });
  }

  async function waitFor(check: () => boolean) {
    const until = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > until) {
        throw new Error("timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function openSocket(
    player: string,
    protocol: Protocol = "graphql-transport-ws",
  ): Promise<Socket> {
    const ws = new WebSocket(`ws://${endpoint}/v1/graphql`, [protocol]);
    const socket: Socket = {
      ws,
      protocol,
      messages: [],
      closed: new Promise((resolve) => ws.on("close", resolve)),
    };
    sockets.push(socket);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
      socket.messages.push(message);
    });
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(
      JSON.stringify({
        type: "connection_init",
        payload: { headers: { "x-test-player": player } },
      }),
    );
    await waitFor(() =>
      socket.messages.some((message) => message.type === "connection_ack"),
    );
    return socket;
  }

  async function socketInsert(socket: Socket) {
    const id = String(++opId);
    socket.ws.send(
      JSON.stringify({
        id,
        type: socket.protocol === "graphql-ws" ? "start" : "subscribe",
        payload: { query: INSERT },
      }),
    );
    await waitFor(() =>
      socket.messages.some(
        (message) =>
          message.id === id && ["next", "data", "error"].includes(message.type),
      ),
    );
    const reply = socket.messages.find((message) => message.id === id);
    return reply.payload?.data?.insert_session_probe_one?.role;
  }

  async function httpInsert(player: string) {
    const response = await fetch(`http://${endpoint}/v1/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-player": player },
      body: JSON.stringify({ query: INSERT }),
    });
    const { data } = await response.json();
    return data?.insert_session_probe_one?.role;
  }

  it("keeps the role a socket opened with when the hook gives no max-age", async () => {
    answer("no-max-age", "administrator");
    const socket = await openSocket("no-max-age");
    expect(await socketInsert(socket)).toBe("administrator");

    answer("no-max-age", "user");

    expect(await socketInsert(socket)).toBe("administrator");
    expect(calls.get("no-max-age")).toBe(1);
  });

  it.each<Protocol>(["graphql-transport-ws", "graphql-ws"])(
    "drops a %s socket at the max-age in the hook's body, and the next socket asks again",
    async (protocol) => {
      const player = `max-age-${protocol}`;
      answer(player, "administrator", { "Cache-Control": "max-age=2" });
      const socket = await openSocket(player, protocol);
      expect(await socketInsert(socket)).toBe("administrator");

      answer(player, "user", { "Cache-Control": "max-age=2" });

      expect(await socket.closed).toBe(1006);
      expect(calls.get(player)).toBe(1);

      const reconnected = await openSocket(player, protocol);
      expect(await socketInsert(reconnected)).toBe("user");
      expect(calls.get(player)).toBe(2);
    },
  );

  it("asks the hook on every HTTP request, whatever max-age it gave", async () => {
    answer("http", "administrator", { "Cache-Control": "max-age=300" });
    expect(await httpInsert("http")).toBe("administrator");

    answer("http", "user", { "Cache-Control": "max-age=300" });

    expect(await httpInsert("http")).toBe("user");
    expect(calls.get("http")).toBe(2);
  });
});
