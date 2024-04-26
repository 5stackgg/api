import { Module } from "@nestjs/common";
import { CacheService } from "./cache.service";
import { RedisModule } from "../redis/redis.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [RedisModule],
  exports: [CacheService],
  providers: [CacheService, loggerFactory()],
})
export class CacheModule {}
