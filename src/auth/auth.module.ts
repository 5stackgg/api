import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { PassportModule } from "@nestjs/passport";
import { SteamStrategy } from "./strategies/SteamStrategy";
import { HasuraModule } from "../hasura/hasura.module";
import { SteamSerializer } from "./strategies/SteamSerializer";
import { DiscordStrategy } from "./strategies/DiscordStrategy";
import { loggerFactory } from "../utilities/LoggerFactory";
import { CacheModule } from "../cache/cache.module";

@Module({
  imports: [
    PassportModule.register({
      session: true,
    }),
    HasuraModule,
    CacheModule,
  ],
  providers: [SteamStrategy, DiscordStrategy, SteamSerializer, loggerFactory()],
  controllers: [AuthController],
})
export class AuthModule {}
