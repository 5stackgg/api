import { Module } from "@nestjs/common";
import { RedisManagerService } from "./redis-manager/redis-manager.service";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  exports: [RedisManagerService],
  providers: [RedisManagerService, loggerFactory()],
})
export class RedisModule {}
