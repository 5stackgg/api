import { forwardRef, Module } from "@nestjs/common";
import { DiscordTournamentVoiceService } from "./discord-tournament-voice.service";
import { DiscordBotModule } from "../discord-bot.module";
import { HasuraModule } from "../../hasura/hasura.module";
import { CacheModule } from "../../cache/cache.module";
import { loggerFactory } from "../../utilities/LoggerFactory";

@Module({
  imports: [
    forwardRef(() => DiscordBotModule),
    HasuraModule,
    CacheModule,
  ],
  providers: [DiscordTournamentVoiceService, loggerFactory()],
  exports: [DiscordTournamentVoiceService],
})
export class DiscordTournamentVoiceModule {}
