import { ButtonInteraction } from "discord.js";
import DiscordInteraction from "./abstracts/DiscordInteraction";
import { ButtonActions } from "../enums/ButtonActions";
import { e_match_status_enum } from "../../../generated";
import { BotButtonInteraction } from "./interactions";

@BotButtonInteraction(ButtonActions.MatchStatus)
export default class UpdateMatchStatus extends DiscordInteraction {
  async handler(interaction: ButtonInteraction) {
    const [, matchId, status] = interaction.customId.split(":");

    await this.matchAssistant.updateMatchStatus(
      matchId,
      status as e_match_status_enum,
    );
  }
}
