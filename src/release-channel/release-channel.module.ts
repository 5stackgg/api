import { Module } from "@nestjs/common";
import { ReleaseChannelService } from "./release-channel.service";
import { CacheModule } from "../cache/cache.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [CacheModule, PostgresModule],
  exports: [ReleaseChannelService],
  providers: [ReleaseChannelService, loggerFactory()],
})
export class ReleaseChannelModule {}
