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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const configService = app.get(ConfigService);

  app.connectMicroservice({
    transport: Transport.REDIS,
    options: {
      ...configService.get("redis").connections.default,
      wildcards: true,
    },
  });

  const appName = process.env.APP_NAME || "5stack";

  app.set("trust proxy", () => {
    // TODO - trust proxy
    return true;
  });

  const redisManagerService = app.get(RedisManagerService);

  app.use(
    session({
      rolling: true,
      resave: false,
      name: appName,
      saveUninitialized: false,
      secret: process.env.ENC_SECRET as string,
      cookie: getCookieOptions(),
      store: new RedisStore({
        prefix: appName,
        client: redisManagerService.getConnection(),
      }),
    })
  );

  app.use(passport.initialize());
  app.use(passport.session());

  app.useWebSocketAdapter(new WsAdapter(app));

  await app.startAllMicroservices();
  await app.listen(5585);
}

bootstrap();
