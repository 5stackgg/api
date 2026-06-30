import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { CacheModule } from "../cache/cache.module";
import { PostgresModule } from "../postgres/postgres.module";
import { RedisModule } from "../redis/redis.module";
import { SteamMatchHistoryQueues } from "../steam-match-history/enums/SteamMatchHistoryQueues";
import { loggerFactory } from "../utilities/LoggerFactory";
import { SteamPresenceService } from "./steam-presence.service";
import { SteamPresenceController } from "./steam-presence.controller";

@Module({
  imports: [
    BullModule.registerQueue({
      name: SteamMatchHistoryQueues.PollSteamMatchHistoryForUser,
    }),
    CacheModule,
    PostgresModule,
    RedisModule,
  ],
  providers: [SteamPresenceService, loggerFactory()],
  controllers: [SteamPresenceController],
  exports: [SteamPresenceService],
})
export class SteamPresenceModule {}
