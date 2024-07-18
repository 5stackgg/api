import { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { MatchAssistantService } from "../../../matches/match-assistant/match-assistant.service";
import { DiscordBotService } from "../../discord-bot.service";
import { DiscordBotVoiceChannelsService } from "../../discord-bot-voice-channels/discord-bot-voice-channels.service";
import { DiscordBotMessagingService } from "../../discord-bot-messaging/discord-bot-messaging.service";
import { DiscordPickPlayerService } from "../../discord-pick-player/discord-pick-player.service";
import { DiscordBotOverviewService } from "../../discord-bot-overview/discord-bot-overview.service";
import { DiscordBotVetoService } from "../../discord-bot-veto/discord-bot-veto.service";
import { HasuraService } from "../../../hasura/hasura.service";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export default abstract class DiscordInteraction {
  constructor(
    protected readonly logger: Logger,
    protected readonly config: ConfigService,
    protected readonly hasura: HasuraService,
    protected readonly bot: DiscordBotService,
    protected readonly matchAssistant: MatchAssistantService,
    protected readonly discordBotVeto: DiscordBotVetoService,
    protected readonly discordPickPlayer: DiscordPickPlayerService,
    protected readonly discordBotMessaging: DiscordBotMessagingService,
    protected readonly discordMatchOverview: DiscordBotOverviewService,
    protected readonly discordBotVoiceChannels: DiscordBotVoiceChannelsService,
  ) {}

  public abstract handler(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
  ): Promise<void>;
}
