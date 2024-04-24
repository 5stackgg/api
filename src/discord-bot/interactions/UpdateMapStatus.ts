import { ButtonInteraction } from "discord.js";
import { e_match_status_enum } from "@/../generated/zeus";
import DiscordInteraction from "./abstracts/DiscordInteraction";
import { BotButtonInteraction } from "../discord-bot.service";
import { ButtonActions } from "../enums/ButtonActions";

@BotButtonInteraction(ButtonActions.MapStatus)
export default class UpdateMapStatus extends DiscordInteraction {
  async handler(interaction: ButtonInteraction) {
    const [, matchId, status] = interaction.customId.split(":");

    await this.matchAssistant.updateMatchStatus(
      matchId,
      status as e_match_status_enum
    );
  }
}
