import { Module } from "@nestjs/common";
import { CacheService } from "./cache.service";
import { RedisModule } from "../redis/redis.module";

@Module({
  imports: [RedisModule],
  exports: [CacheService],
  providers: [CacheService],
})
export class CacheModule {}
