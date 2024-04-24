import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { PassportModule } from "@nestjs/passport";
import { SteamStrategy } from "./strategies/SteamStrategy";
import { HasuraModule } from "../hasura/hasura.module";
import { SteamSerializer } from "./strategies/SteamSerializer";
import { DiscordStrategy } from "./strategies/DiscordStrategy";

@Module({
  imports: [
    PassportModule.register({
      session: true,
    }),
    HasuraModule,
  ],
  providers: [AuthService, SteamStrategy, DiscordStrategy, SteamSerializer],
  controllers: [AuthController],
})
export class AuthModule {}
