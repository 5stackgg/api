import {
  CategoryChannel,
  ChannelType,
  ChatInputCommandInteraction,
  CommandInteractionOption,
  GuildChannel,
  User as DiscordUser,
  ThreadAutoArchiveDuration,
  PermissionsBitField,
  StringSelectMenuBuilder,
  ActionRowBuilder,
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

    let customMapPool: string[];

    if (options["custom-map-pool"]) {
      const maps = await this.getMapChoices(matchType);

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("multi_select")
        .setPlaceholder("Choose custom map pool")
        .setMinValues(1)
        .setMaxValues(maps.length)
        .addOptions(maps);

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        selectMenu,
      );

      const customMapPoolReply = await interaction.reply({
        content: "Create your custom map pool:",
        components: [row],
        fetchReply: true,
      });

      await new Promise<void>((resolve) => {
        const collector = customMapPoolReply.createMessageComponentCollector({
          time: 60 * 1000,
        });

        collector.on("collect", async (selections) => {
          if (selections.isStringSelectMenu()) {
            customMapPool = selections.values;
            collector.stop();
          }
        });

        collector.on("end", () => {
          resolve();
        });
      });

      if (customMapPool.length === 0) {
        await interaction.followUp({
          ephemeral: true,
          content: "Custom map pool selection timed out.",
        });
        return;
      }

      await customMapPoolReply.delete();
    }

    const guild = await this.bot.client.guilds.fetch(interaction.guildId);

    let teamSelectionChannel;
    if (options["team-selection"]) {
      teamSelectionChannel = (await guild.channels.fetch(
        options["team-selection"],
      )) as undefined as GuildChannel;
    } else {
      const member = await guild.members.fetch(interaction.user.id);
      teamSelectionChannel = member.voice.channel;
    }

    if (!teamSelectionChannel) {
      await interaction.reply({
        ephemeral: true,
        content:
          "You need to be in a voice channel to use this command without specifying a channel.",
      });
      return;
    }

    const usersInChannel = await this.getUsersInChannel(teamSelectionChannel);

    if (usersInChannel.length < ExpectedPlayers[matchType]) {
      const notEnoughUsersMessage = `Not enough users for captain selection`;
      if (interaction.replied) {
        await interaction.followUp({
          ephemeral: true,
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

    const match = await this.matchAssistant.createMatchBasedOnType(
      matchType,
      mapPoolType,
      {
        mr: options.mr,
        best_of: options.best_of,
        knife: options.knife,
        map: options.map,
        overtime: options.overtime,
        maps: customMapPool,
      },
    );
    const matchId = match.id;

    await this.discordPickPlayer.setAvailablePlayerPool(
      matchId,
      usersInChannel,
    );

    const categoryChannel = await this.createMatchesCategory(interaction);

    const channel = await this.createMatchThread(
      categoryChannel,
      matchId,
      usersInChannel,
    );

    await interaction.reply({
      ephemeral: true,
      content: `Match Created: ${channel}`,
    });

    await this.createVoiceChannelsForMatch(
      teamSelectionChannel.id,
      categoryChannel,
      match,
    );

    if (options.captains) {
      const { captain1, captain2 } = await this.getCaptains(
        options,
        usersInChannel,
      );

      await this.discordPickPlayer.addDiscordUserToLineup(
        matchId,
        match.lineup_1_id,
        captain1,
      );

      await this.discordPickPlayer.addDiscordUserToLineup(
        matchId,
        match.lineup_2_id,
        captain2,
      );

      await this.discordPickPlayer.pickMember(matchId, match.lineup_1_id, 1);

      return;
    }

    const availableUsers = usersInChannel;
    const shuffledUsers = availableUsers.sort(() => Math.random() - 0.5);

    const playersPerTeam = matchType === "Wingman" ? 2 : 5;
    for (let playerIndex = 0; playerIndex < playersPerTeam * 2; playerIndex++) {
      if (playerIndex < shuffledUsers.length) {
        const user = shuffledUsers[playerIndex];
        const lineupId =
          playerIndex < playersPerTeam ? match.lineup_1_id : match.lineup_2_id;

        await this.discordPickPlayer.addDiscordUserToLineup(
          matchId,
          lineupId,
          user,
        );
      }
    }

    await this.discordPickPlayer.startVeto(matchId);
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
      captains: false,
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
  ): Promise<CategoryChannel> {
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

  private async createMatchThread(
    categoryChannel: CategoryChannel,
    matchId: string,
    usersInChannel: DiscordUser[],
  ) {
    const guild = await this.bot.client.guilds.fetch(categoryChannel.guildId);

    const textChannel = await guild.channels.create<ChannelType.GuildText>({
      name: `Match ${matchId}`,
      parent: categoryChannel.id,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: guild.client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ManageThreads,
            PermissionsBitField.Flags.CreatePublicThreads,
            PermissionsBitField.Flags.CreatePrivateThreads,
          ],
        },
        ...usersInChannel.map((user) => ({
          id: user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
          ],
        })),
      ],
    });

    const reply = await textChannel.send({
      content: `Setting up match ${matchId}`,
    });

    await this.discordBotMessaging.setMatchReplyCache(matchId, reply);

    const thread = await textChannel.threads.create({
      name: `Match ${matchId}`,
      reason: `Match ${matchId}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });

    await this.discordBotMessaging.setMatchThreadCache(matchId, thread);

    return textChannel;
  }

  private async createVoiceChannelsForMatch(
    originalChannelId: string,
    categoryChannel: CategoryChannel,
    match: UnwrapPromise<
      ReturnType<typeof this.matchAssistant.createMatchBasedOnType>
    >,
  ) {
    const matchId = match.id;

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

  private async getMapChoices(type: e_match_types_enum) {
    const { maps } = await this.hasura.query({
      maps: {
        __args: {
          where: {
            type: {
              _eq: type,
            },
          },
        },
        id: true,
        name: true,
      },
    });

    return maps.map((map) => ({
      label: map.name,
      value: map.id,
    }));
  }
}
