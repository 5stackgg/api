import { ButtonInteraction } from "discord.js";
import { ButtonActions } from "../enums/ButtonActions";
import DiscordInteraction from "./abstracts/DiscordInteraction";
import { BotButtonInteraction } from "./interactions";

@BotButtonInteraction(ButtonActions.VetoPick)
export default class VetoPick extends DiscordInteraction {
  async handler(interaction: ButtonInteraction) {
    const [, matchId, mapIndex] = interaction.customId.split(":");

    const userId = interaction.user.id;

    const match = await this.matchAssistant.getMatchLineups(matchId);

    const lineup =
      match.map_veto_picking_lineup_id === match.lineup_1.id
        ? match.lineup_1
        : match.lineup_2;

    if (
      !lineup.lineup_players.find((lineup_player) => {
        return lineup_player.discord_id === userId;
      })
    ) {
      await interaction.reply({
        ephemeral: true,
        content: "your team is not currently map banning",
      });
      return;
    }
    const votes = await this.discordBotVeto.getUserVotes(matchId, userId);

    const hasVote = votes.indexOf(mapIndex);
    if (hasVote === -1) {
      if (votes.length) {
        await interaction.reply({
          ephemeral: true,
          content: `You are only allowed to select 1 map`,
        });
        return;
      }

      votes.push(mapIndex);
    } else {
      // remove vote
      votes.splice(hasVote);
    }

    await this.discordBotVeto.updateUserVotes(matchId, userId, votes);

    // if all the players have voted
    if (
      lineup.lineup_players.length ===
      (await this.discordBotVeto.getTotalBanVotes(matchId))
    ) {
      await this.discordBotVeto.clearBanTimeout(matchId);
      await this.discordBotVeto.pickVeto(matchId);
    } else {
      await this.discordMatchOverview.updateMatchOverview(matchId);
    }

    try {
      await interaction.reply({ ephemeral: true });
    } catch (error) {
      if (!error.message.includes("empty message")) {
        this.logger.error(`[${matchId}] unable to reply to interaction`, error);
      }
    }
  }
}
