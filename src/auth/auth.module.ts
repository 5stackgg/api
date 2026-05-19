import { Module, forwardRef } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { PassportModule } from "@nestjs/passport";
import { SteamStrategy } from "./strategies/SteamStrategy";
import { HasuraModule } from "../hasura/hasura.module";
import { SteamSerializer } from "./strategies/SteamSerializer";
import { DiscordStrategy } from "./strategies/DiscordStrategy";
import { loggerFactory } from "../utilities/LoggerFactory";
import { CacheModule } from "../cache/cache.module";
import { RedisModule } from "../redis/redis.module";
import { ApiKeys } from "./ApiKeys";
import { ApiKeyGuard } from "./strategies/ApiKeyGuard";

@Module({
  imports: [
    PassportModule.register({
      session: true,
    }),
    forwardRef(() => HasuraModule),
    CacheModule,
    RedisModule,
  ],
  providers: [
    ApiKeys,
    ApiKeyGuard,
    SteamStrategy,
    DiscordStrategy,
    SteamSerializer,
    loggerFactory(),
  ],
  exports: [ApiKeys, ApiKeyGuard],
  controllers: [AuthController],
})
export class AuthModule {}
