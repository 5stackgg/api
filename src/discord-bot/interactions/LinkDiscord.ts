import { ButtonInteraction } from "discord.js";
import DiscordInteraction from "./abstracts/DiscordInteraction";
import { BotChatCommand } from "./interactions";
import { ChatCommands } from "../enums/ChatCommands";
import { AppConfig } from "src/configs/types/AppConfig";

@BotChatCommand(ChatCommands.LinkDiscord)
export default class LinkDiscord extends DiscordInteraction {
  async handler(interaction: ButtonInteraction) {
    const appConfig = this.config.get<AppConfig>("app");

    const { players } = await this.hasura.query({
      players: {
        __args: {
          where: {
            discord_id: {
              _eq: interaction.user.id,
            },
          },
        },
        steam_id: true,
      },
    });

    if (players.at(0)) {
      await interaction.reply({
        ephemeral: true,
        content: "You have already linked your discord!",
      });
      return;
    }

    await interaction.reply({
      ephemeral: true,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Link Discord",
              url: `${appConfig.webDomain}/link-discord`,
            },
          ],
        },
      ],
    });
  }
}
