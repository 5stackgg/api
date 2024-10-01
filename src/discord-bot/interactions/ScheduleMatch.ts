import {
  ComponentType,
  CategoryChannel,
  ChannelType,
  ChatInputCommandInteraction,
  CommandInteractionOption,
  GuildChannel,
  User as DiscordUser,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Message,
} from "discord.js";
import DiscordInteraction from "./abstracts/DiscordInteraction";
import { ChatCommands } from "../enums/ChatCommands";
import { ExpectedPlayers } from "../enums/ExpectedPlayers";
import { DiscordMatchOptions } from "../types/DiscordMatchOptions";
import { getRandomNumber } from "../utilities/getRandomNumber";
import { AppConfig } from "../../configs/types/AppConfig";
import { e_map_pool_types_enum, e_match_types_enum } from "../../../generated";
import { BotChatCommand } from "./interactions";

type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

@BotChatCommand(ChatCommands.ScheduleComp)
@BotChatCommand(ChatCommands.ScheduleWingMan)
export default class ScheduleMatch extends DiscordInteraction {
  public async handler(interaction: ChatInputCommandInteraction) {
    let matchType: e_match_types_enum;
    let mapPoolType: e_map_pool_types_enum;

    switch (interaction.commandName) {
      case ChatCommands.ScheduleComp:
        matchType = "Competitive";
        mapPoolType = "Competitive";
        break;
      case ChatCommands.ScheduleWingMan:
        matchType = "Wingman";
        mapPoolType = "Wingman";
        break;
      default:
        throw Error(`match type not supported ${interaction.type}`);
    }

    const options = this.getMatchOptions(interaction.options.data, matchType);

    const guild = await this.bot.client.guilds.fetch(interaction.channel);

    const teamSelectionChannel = (await guild.channels.fetch(
      options["team-selection"],
    )) as undefined as GuildChannel;

    const usersInChannel = await this.getUsersInChannel(teamSelectionChannel);

    if (usersInChannel.length < ExpectedPlayers[matchType]) {
      const notEnoughUsersMessage = `Not enough users for captain selection`;
      if (interaction.replied) {
        await interaction.editReply({
          components: [],
          content: notEnoughUsersMessage,
        });
        return;
      }

      await interaction.reply({
        ephemeral: true,
        content: notEnoughUsersMessage,
      });

      return;
    }

    const { captain1, captain2 } = await this.getCaptains(
      options,
      usersInChannel,
    );

    const match = await this.matchAssistant.createMatchBasedOnType(
      matchType,
      mapPoolType,
      {
        mr: options.mr,
        best_of: options.best_of,
        knife: options.knife,
        map: options.map,
        overtime: options.overtime,
      },
    );
    const matchId = match.id;

    await this.discordPickPlayer.setAvailablePlayerPool(
      matchId,
      usersInChannel,
    );

    await this.discordBotMessaging.sendInitialReply(interaction, matchId);

    await this.discordBotMessaging.createMatchThread(matchId);

    await this.createVoiceChannelsForMatch(
      teamSelectionChannel.id,
      interaction,
      match,
    );

    await this.discordPickPlayer.addDiscordUserToLineup(
      matchId,
      match.lineup_1_id,
      captain1,
      true,
    );

    await this.discordPickPlayer.addDiscordUserToLineup(
      matchId,
      match.lineup_2_id,
      captain2,
      true,
    );

    await this.discordPickPlayer.pickMember(matchId, match.lineup_1_id, 1);
  }

  private async getUsersInChannel(channel: GuildChannel) {
    return channel.members.map((member) => {
      return member.user;
    }) as Array<DiscordUser>;
  }

  public getMatchOptions(
    _options: readonly CommandInteractionOption[],
    matchType: e_match_types_enum,
  ) {
    const options: DiscordMatchOptions & {
      // this is to handle the foor loop of _options
      // technically it could have any, but we dont really want to
      // put it on the type it self
      [key: string]: any;
    } = {
      mr: 12,
      best_of: 1,
      knife: true,
      overtime: true,
      captains: true,
    };

    for (const index in _options) {
      const option = _options[index];
      options[option.name] = option.value;
    }

    if (matchType === "Wingman" && options.mr === 12) {
      options.mr = 8;
    }

    return options;
  }

  private async createMatchesCategory(
    interaction: ChatInputCommandInteraction,
  ) {
    const channelName = `${this.config.get<AppConfig>("app").name} Matches`;

    let category: CategoryChannel;
    for (const [, channel] of interaction.guild.channels.cache) {
      if (channel.name === channelName) {
        category = channel as CategoryChannel;
        break;
      }
    }

    if (!category) {
      return (await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildCategory,
      })) as CategoryChannel;
    }

    return category;
  }

  private async createVoiceChannelsForMatch(
    originalChannelId: string,
    interaction: ChatInputCommandInteraction,
    match: UnwrapPromise<
      ReturnType<typeof this.matchAssistant.createMatchBasedOnType>
    >,
  ) {
    const matchId = match.id;
    const categoryChannel = await this.createMatchesCategory(interaction);

    await this.discordBotVoiceChannels.createMatchVoiceChannel(
      matchId,
      categoryChannel.guildId,
      originalChannelId,
      categoryChannel.id,
      match.lineup_1_id,
    );

    await this.discordBotVoiceChannels.createMatchVoiceChannel(
      matchId,
      categoryChannel.guildId,
      originalChannelId,
      categoryChannel.id,
      match.lineup_2_id,
    );
  }

  private async getCaptains(
    discordOptions: DiscordMatchOptions,
    users: DiscordUser[],
  ) {
    let captain1: DiscordUser;
    let captain2: DiscordUser;
    const captain1Override =
      discordOptions["captain-1"] || process.env.CAPTAIN_PICK_1;
    const captain2Override =
      discordOptions["captain-2"] || process.env.CAPTAIN_PICK_2;

    if (captain1Override) {
      captain1 = users.find((member) => {
        return (
          member.id === captain1Override ||
          (member.globalName || member.username)
            .toLowerCase()
            .startsWith(captain1Override.toLowerCase())
        );
      });
    }

    if (captain2Override) {
      captain2 = users.find((member) => {
        return (
          member.id === captain2Override ||
          (member.globalName || member.username)
            .toLowerCase()
            .startsWith(captain2Override.toLowerCase())
        );
      });
    }

    if (!captain1) {
      captain1 = users[getRandomNumber(0, users.length - 1)];
    }

    do {
      const user = users[getRandomNumber(0, users.length - 1)];
      if (user !== captain1) {
        captain2 = user;
      }
    } while (!captain2);

    if (process.env.DEV && captain1 === captain2) {
      captain2 = Object.assign({}, captain2, {
        globalName: "2",
      });
    }

    return {
      captain1,
      captain2,
    };
  }
}
