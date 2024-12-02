import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { HasuraModule } from "./hasura/hasura.module";
import { RconModule } from "./rcon/rcon.module";
import { TypeSenseModule } from "./type-sense/type-sense.module";
import { AuthModule } from "./auth/auth.module";
import { DiscordBotModule } from "./discord-bot/discord-bot.module";
import { MatchesModule } from "./matches/matches.module";

import { TeamsModule } from "./teams/teams.module";
import { EncryptionModule } from "./encryption/encryption.module";
import { CacheModule } from "./cache/cache.module";
import { S3Module } from "./s3/s3.module";
import { QuickConnectController } from "./quick-connect/quick-connect.controller";
import { RedisModule } from "./redis/redis.module";
import { ConfigModule } from "@nestjs/config";
import { DiscordBotService } from "./discord-bot/discord-bot.service";
import { TypeSenseService } from "./type-sense/type-sense.service";
import { BullModule } from "@nestjs/bullmq";
import { RedisManagerService } from "./redis/redis-manager/redis-manager.service";
import { PostgresModule } from "./postgres/postgres.module";
import { BullBoardModule } from "@bull-board/nestjs";
import { ExpressAdapter } from "@bull-board/express";
import configs from "./configs";
import { loggerFactory } from "./utilities/LoggerFactory";
import { SocketsModule } from "./sockets/sockets.module";
import { TailscaleModule } from "./tailscale/tailscale.module";
import { GameServerNodeModule } from "./game-server-node/game-server-node.module";
import { MatchMakingModule } from "./match-making/match-making.module";
import { SystemModule } from "./system/system.module";
import { NotificationsModule } from "./notifications/notifications.module";

@Module({
  imports: [
    AuthModule,
    DiscordBotModule,
    HasuraModule,
    RconModule,
    SocketsModule,
    TypeSenseModule,
    MatchesModule,
    MatchMakingModule,
    TeamsModule,
    EncryptionModule,
    CacheModule,
    S3Module,
    RedisModule,
    PostgresModule,
    TailscaleModule,
    BullModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisManagerService],
      useFactory: async (redisManagerService: RedisManagerService) => {
        return {
          connection: redisManagerService.getConnection(),
          defaultJobOptions: {
            removeOnComplete: {
              // 24 hours
              age: 24 * 3600,
            },
            removeOnFail: {
              // 24 hours
              age: 7 * 24 * 3600,
            },
          },
        };
      },
    }),
    BullBoardModule.forRoot({
      route: "/queues",
      adapter: ExpressAdapter,
    }),
    ConfigModule.forRoot({
      isGlobal: true,
      load: configs,
    }),
    GameServerNodeModule,
    SystemModule,
    NotificationsModule,
  ],
  providers: [loggerFactory()],
  controllers: [AppController, QuickConnectController],
})
export class AppModule {
  constructor(
    private readonly typesense: TypeSenseService,
    private readonly discordBot: DiscordBotService,
  ) {
    void this.setup();
  }

  private async setup() {
    await this.typesense.setup();
    await this.discordBot.setupBot();
  }
}
