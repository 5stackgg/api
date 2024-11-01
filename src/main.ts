import os from "os";
import cluster from "cluster";
import session from "express-session";
import { NestFactory } from "@nestjs/core";
import { Transport } from "@nestjs/microservices";
import { AppModule } from "./app.module";
import RedisStore from "connect-redis";
import { getCookieOptions } from "./utilities/getCookieOptions";
import { NestExpressApplication } from "@nestjs/platform-express";
import passport from "passport";
import { WsAdapter } from "@nestjs/platform-ws";
import { RedisManagerService } from "./redis/redis-manager/redis-manager.service";
import { ConfigService } from "@nestjs/config";
import { RedisConfig } from "./configs/types/RedisConfig";
import { AppConfig } from "./configs/types/AppConfig";
import { HasuraService } from "./hasura/hasura.service";
import { SystemService } from "./system/system.service";

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

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  if (process.env.RUN_MIGRATIONS || process.env.DEV) {
    const hasura = app.get(HasuraService);
    await hasura.setup();
    if (!process.env.DEV) {
      process.exit(0);
    }
  }

  const configService = app.get(ConfigService);

  app.connectMicroservice({
    transport: Transport.REDIS,
    options: {
      ...configService.get<RedisConfig>("redis").connections.default,
      wildcards: true,
    },
  });

  app.set("trust proxy", () => {
    // TODO - trust proxy
    return true;
  });

  const systemService = app.get(SystemService);
  const redisManagerService = app.get(RedisManagerService);

  await systemService.detectFeatures();

  const appConfig = configService.get<AppConfig>("app");

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

  app.useWebSocketAdapter(new WsAdapter(app));

  await app.startAllMicroservices();
  await app.listen(5585);
}

bootstrap();
