import { Module } from "@nestjs/common";
import { DiscordBotService } from "./discord-bot.service";
import { DiscordBotController } from "./discord-bot.controller";
import { DiscordBotMessagingService } from "./discord-bot-messaging/discord-bot-messaging.service";
import { DiscordBotOverviewService } from "./discord-bot-overview/discord-bot-overview.service";
import { DiscordPickPlayerService } from "./discord-pick-player/discord-pick-player.service";
import { DiscordBotVoiceChannelsService } from "./discord-bot-voice-channels/discord-bot-voice-channels.service";
import { DiscordBotVetoService } from "./discord-bot-veto/discord-bot-veto.service";
import { CacheModule } from "../cache/cache.module";
import { HasuraModule } from "../hasura/hasura.module";
import { MatchesModule } from "../matches/matches.module";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { DiscordBotQueues } from "./enums/DiscordBotQueues";
import { UpdateDiscordMatchVetoJob } from "./jobs/UpdateDiscordMatchVetoJob";

@Module({
  imports: [
    CacheModule,
    HasuraModule,
    MatchesModule,
    BullModule.registerQueue({
      name: DiscordBotQueues.DiscordBot,
    }),
    BullBoardModule.forFeature({
      name: DiscordBotQueues.DiscordBot,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    DiscordBotService,
    DiscordBotMessagingService,
    DiscordBotOverviewService,
    DiscordBotVetoService,
    DiscordBotVoiceChannelsService,
    DiscordPickPlayerService,
    UpdateDiscordMatchVetoJob,
  ],
  exports: [
    DiscordBotService,
    DiscordBotMessagingService,
    DiscordBotOverviewService,
    DiscordBotVetoService,
    DiscordBotVoiceChannelsService,
    DiscordPickPlayerService,
  ],
  controllers: [DiscordBotController],
})
export class DiscordBotModule {}
