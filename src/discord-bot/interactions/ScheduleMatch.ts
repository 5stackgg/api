import {
  CategoryChannel,
  ChannelType,
  ChatInputCommandInteraction,
  CommandInteractionOption,
  GuildChannel,
  User as DiscordUser,
  PermissionsBitField,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ButtonBuilder,
  MessageFlags,
  Guild,
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
@BotChatCommand(ChatCommands.ScheduleDuel)
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
      case ChatCommands.ScheduleDuel:
        matchType = "Duel";
        mapPoolType = "Duel";
        break;
      default:
        throw Error(`match type not supported ${interaction.type}`);
    }

    const options = this.getMatchOptions(interaction.options.data, matchType);

    const customMapPools: { custom_maps: string[]; active_duty: string[] } = {
      custom_maps: [],
      active_duty: [],
    };

    if (options["custom-map-pool"]) {
      const maps = await this.getMapChoices(matchType);

      const activeDutyMaps = maps
        .filter((map) => !map.workshop_map_id)
        .map((map) => ({ label: map.name, value: map.id }))
        .slice(0, 25);
      const customMaps = maps
        .filter((map) => map.workshop_map_id)
        .map((map) => ({ label: map.name, value: map.id }))
        .slice(0, 25);

      const activeDutySelectMenu = new StringSelectMenuBuilder()
        .setCustomId("active_duty")
        .setPlaceholder("Active Duty Maps")
        .setMinValues(0)
        .setMaxValues(activeDutyMaps.length)
        .addOptions(activeDutyMaps);

      const nonActiveDutySelectMenu = new StringSelectMenuBuilder()
        .setCustomId("custom_maps")
        .setPlaceholder("Custom Maps")
        .setMinValues(0)
        .setMaxValues(customMaps.length)
        .addOptions(customMaps);

      const confirmButton = new ButtonBuilder()
        .setCustomId("confirm_map_pool")
        .setLabel("Confirm Map Pool")
        .setStyle(ButtonStyle.Primary);

      const customMapPoolReply = await interaction.reply({
        content: "Create your custom map pool:",
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            activeDutySelectMenu,
          ),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            nonActiveDutySelectMenu,
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton),
        ],
        fetchReply: true,
      });

      await new Promise<void>((resolve) => {
        const collector = customMapPoolReply.createMessageComponentCollector({
          time: 60 * 1000,
        });

        collector.on("collect", async (selections) => {
          if (selections.isStringSelectMenu()) {
            customMapPools[
              selections.customId as "custom_maps" | "active_duty"
            ] = selections.values;
            selections.deferUpdate();
          }

          if (selections.isButton()) {
            collector.stop();
          }
        });

        collector.on("end", () => {
          resolve();
        });
      });

      await customMapPoolReply.delete();

      if (
        customMapPools["custom_maps"].length === 0 &&
        customMapPools["active_duty"].length === 0
      ) {
        await interaction.followUp({
          flags: MessageFlags.Ephemeral,
          content: "Custom map pool selection timed out.",
        });
        return;
      }
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
      if (interaction.replied) {
        await interaction.followUp({
          flags: MessageFlags.Ephemeral,
          content:
            "You need to be in a voice channel to use this command without specifying a channel.",
        });
      } else {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content:
            "You need to be in a voice channel to use this command without specifying a channel.",
        });
      }
      return;
    }

    const usersInChannel = await this.getUsersInChannel(teamSelectionChannel);

    if (usersInChannel.length < ExpectedPlayers[matchType]) {
      const notEnoughUsersMessage = `Not enough players for ${matchType}`;
      if (interaction.replied) {
        await interaction.followUp({
          flags: MessageFlags.Ephemeral,
          content: notEnoughUsersMessage,
        });
        return;
      }

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: notEnoughUsersMessage,
      });

      return;
    }

    let captain1: DiscordUser;
    let captain2: DiscordUser;

    if (options.captains) {
      const captains = await this.getCaptains(options, usersInChannel);

      captain1 = captains.captain1;
      captain2 = captains.captain2;

      if (!captain1 || !captain2) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "Unable to assign captains",
        });

        return;
      }
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
        maps: [
          ...customMapPools["active_duty"],
          ...customMapPools["custom_maps"],
        ],
      },
    );
    const matchId = match.id;

    await this.discordPickPlayer.setAvailablePlayerPool(
      matchId,
      usersInChannel,
    );

    const categoryChannel = await this.discordBotMessaging.getCategory(
      `${this.config.get<AppConfig>("app").name} Matches`,
      interaction.guild,
    );

    const { textChannel: matchTextChannel, reply: matchThreadReply } =
      await this.createMatchThread(categoryChannel, matchId, usersInChannel);

    if (interaction.replied) {
      await interaction.followUp({
        flags: MessageFlags.Ephemeral,
        content: `Match Created: ${matchTextChannel}`,
      });
    } else {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `Match Created: ${matchTextChannel}`,
      });
    }

    await this.createVoiceChannelsForMatch(
      teamSelectionChannel.id,
      categoryChannel,
      match,
    );

    for (const member of usersInChannel) {
      await member
        .send({
          forward: {
            message: matchThreadReply,
          },
        })
        .catch((error) => {
          if (error.code !== 50007) {
            this.logger.warn(
              `[${matchId}] unable to send message to user`,
              error,
            );
          }
        });
    }

    if (options.captains) {
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

    const playersPerTeam = ExpectedPlayers[matchType] / 2;
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

    await this.discordPickPlayer.startMatch(matchId);
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

    if (matchType !== "Competitive") {
      options.mr = 8;
    }

    return options;
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
      content: `Match Created: ${matchId}`,
    });

    await this.discordBotMessaging.setMatchReplyCache(matchId, reply);

    const thread = await textChannel.threads.create({
      name: `Match ${matchId}`,
      reason: `Match ${matchId}`,
    });

    await this.discordBotMessaging.setMatchThreadCache(matchId, thread);

    return {
      reply,
      textChannel,
    };
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
        active_pool: true,
        workshop_map_id: true,
      },
    });

    return maps;
  }
}
