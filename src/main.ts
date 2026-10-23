import session from "express-session";
import { Server, ServerResponse } from "http";
import { INestApplication } from "@nestjs/common";
import { DiscoveryService, NestFactory } from "@nestjs/core";
import { WorkerHost } from "@nestjs/bullmq";
import { Transport } from "@nestjs/microservices";
import { AppModule } from "./app.module";
import RedisStore from "connect-redis";
import { getCookieOptions } from "./utilities/getCookieOptions";
import { isAllowedOrigin } from "./utilities/isAllowedOrigin";
import { NestExpressApplication } from "@nestjs/platform-express";
import passport from "passport";
import { WebSocketAdapter } from "./sockets/web-socket.adapter";
import { RedisManagerService } from "./redis/redis-manager/redis-manager.service";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "./configs/types/AppConfig";
import { HasuraService } from "./hasura/hasura.service";
import { logLevels } from "./utilities/LoggerFactory";
import { registerBodyParsers } from "./body-parsers";

/**
 * Increase the max listeners, based on load we may need to increase this
 */
require("events").EventEmitter.defaultMaxListeners = Number(
  process.env.NODE_MAX_LISTENERS || "100",
);

// The pod gets 30 seconds between SIGTERM and SIGKILL; this leaves room for
// the exit itself.
export const SHUTDOWN_DEADLINE_MS = 27_000;

// Long enough for the pod's removal from the Service to reach the ingress, so
// requests stop arriving before the listener goes.
export const SHUTDOWN_ENDPOINT_DELAY_MS = 5_000;

export const SHUTDOWN_REQUEST_DRAIN_MS = 10_000;

// node is PID 1 in the container, where SIGTERM does nothing unless something
// handles it, so every deploy waited out the grace period and was killed.
//
// Nest's app.close() is deliberately not called: it closes every socket, and
// the sockets' close handlers end demo playback, node sessions and lobby
// presence that the new pod picks up. The sockets drop with the process, as
// they always have, and their clients reconnect to the new pod.
export function closeOnShutdownSignals(app: INestApplication) {
  const server: Server = app.getHttpServer();
  const inFlight = new Set<ServerResponse>();
  let closing = false;
  let idle = () => {};

  // A kept-alive connection, like Hasura's pooled ones, stays on this pod and
  // can bring in requests after the listener closes, so once shutting down
  // every response closes its connection. Ahead of Express, which can answer
  // a request before a later listener sees it.
  server.prependListener("request", (_request, response: ServerResponse) => {
    if (closing) {
      response.setHeader("Connection", "close");
    }
    inFlight.add(response);
    response.once("close", () => {
      inFlight.delete(response);
      if (closing) {
        server.closeIdleConnections();
      }
      if (inFlight.size === 0) {
        idle();
      }
    });
  });

  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) {
      process.exit(1);
      return;
    }
    closing = true;

    // A dev restart (start:dev, the hot-swap pod) has to come straight back.
    if (process.env.DEV) {
      server.close();
      process.exit(0);
      return;
    }

    const deadline = setTimeout(() => {
      console.warn(
        `api did not shut down within ${SHUTDOWN_DEADLINE_MS}ms of ${signal}, exiting`,
      );
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);

    for (const response of inFlight) {
      if (!response.headersSent) {
        response.setHeader("Connection", "close");
      }
    }

    // The new pod is already up with its own workers, so these stop taking
    // jobs now. Job classes extend WorkerHost too; only the queue processors
    // have a worker.
    const workersClosed = Promise.allSettled(
      app
        .get(DiscoveryService)
        .getProviders()
        .map(({ instance }) => instance)
        .filter((instance) => instance instanceof WorkerHost)
        .flatMap((host: WorkerHost) => {
          try {
            return [host.worker];
          } catch {
            return [];
          }
        })
        .map((worker) => worker.close()),
    );

    // Only a pod being replaced has endpoints to wait out.
    if (signal === "SIGTERM") {
      await wait(SHUTDOWN_ENDPOINT_DELAY_MS);
    }

    // Upgraded sockets keep the server open, so its callback is not awaited.
    server.close();
    let capped = false;
    const cap = wait(SHUTDOWN_REQUEST_DRAIN_MS).then(() => {
      capped = true;
    });

    await workersClosed;

    // Checked again as each request finishes, since another can come in as
    // the last one does.
    while (inFlight.size > 0 && !capped) {
      await Promise.race([
        new Promise<void>((resolve) => {
          idle = resolve;
        }),
        cap,
      ]);
    }

    clearTimeout(deadline);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function bootstrap() {
  // TODO - handle clustering, but need to move web sockets to redis
  // if (cluster.isPrimary) {
  //     const numCPUs = os.cpus().length;
  //     console.log(`Master process is running. Forking ${numCPUs} workers...`);
  //
  //     // Fork workers.
  //     for (let i = 0; i < numCPUs; i++) {
  //         cluster.fork();
  //     }
  //
  //     cluster.on('exit', (worker, code, signal) => {
  //         console.log(`Worker ${worker.process.pid} died. Forking a new one...`);
  //         cluster.fork();
  //     });
  //     return;
  // }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: logLevels(),
  });
  app.disable("x-powered-by");

  registerBodyParsers(app);

  if (process.env.RUN_MIGRATIONS || process.env.DEV) {
    const hasura = app.get(HasuraService);
    try {
      await hasura.setup();
    } catch (error) {
      console.warn("hasura is not able to be setup, exiting", error);
      process.exit(1);
    }
    if (process.env.RUN_MIGRATIONS) {
      process.exit(0);
    }
  }

  closeOnShutdownSignals(app);

  const configService = app.get(ConfigService);
  const redisManagerService = app.get(RedisManagerService);

  app.connectMicroservice({
    transport: Transport.REDIS,
    options: {
      ...redisManagerService.getConfig("default"),
      wildcards: true,
    },
  });

  app.set("trust proxy", 1);

  const appConfig = configService.get<AppConfig>("app");

  const allowedOrigins = [
    appConfig.webDomain,
    appConfig.apiDomain,
    appConfig.relayDomain,
    appConfig.demosDomain,
    appConfig.wsDomain,
    // Anywhere else the panel is served from, for origins outside the cookie
    // domain that isAllowedOrigin covers on its own -- a trycloudflare or ngrok
    // hostname, say.
    ...appConfig.extraCorsOrigins,
  ];

  if (process.env.DEV) {
    allowedOrigins.push(
      "http://localhost:3000",
      "http://0.0.0.0:3000",
      "http://localhost:3002",
      "http://0.0.0.0:3002",
    );
  }

  const allowOrigin = isAllowedOrigin({
    origins: allowedOrigins,
    cookieDomain: appConfig.authCookieDomain,
  });

  app.enableCors({
    origin: (origin, callback) => callback(null, allowOrigin(origin)),
    credentials: true,
  });

  app.use(
    session({
      rolling: true,
      resave: false,
      name: appConfig.name,
      saveUninitialized: false,
      secret: appConfig.encSecret,
      cookie: getCookieOptions(),
      store: new RedisStore({
        prefix: `${appConfig.name}:auth:`,
        client: redisManagerService.getConnection(),
      }),
    }),
  );

  app.use(passport.initialize());
  app.use(passport.session());

  app.useWebSocketAdapter(new WebSocketAdapter(app, allowOrigin));

  await app.startAllMicroservices();
  await app.listen(5585);
}

if (require.main === module) {
  // The queue workers keep the process alive, so a failed boot would otherwise
  // leave an api that never listens until the startup probe gives up.
  bootstrap().catch((error) => {
    console.error("api is not able to start, exiting", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason, p) => {
    console.warn("Unhandled Rejection at: Promise", p, "reason:", reason);
  });
}
