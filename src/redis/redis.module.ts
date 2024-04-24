import { Module } from "@nestjs/common";
import { RedisManagerService } from "./redis-manager/redis-manager.service";

@Module({
  exports: [RedisManagerService],
  providers: [RedisManagerService],
})
export class RedisModule {}
