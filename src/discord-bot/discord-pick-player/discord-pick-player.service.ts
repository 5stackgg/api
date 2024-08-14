import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import {
  ActionRowBuilder,
  ComponentType,
  Message,
  StringSelectMenuBuilder,
  User,
} from "discord.js";
import { getDiscordDisplayName } from "../utilities/getDiscordDisplayName";
import { ExpectedPlayers } from "../enums/ExpectedPlayers";
import { CacheService } from "../../cache/cache.service";
import { DiscordBotService } from "../discord-bot.service";
import { MatchAssistantService } from "../../matches/match-assistant/match-assistant.service";
import { DiscordBotMessagingService } from "../discord-bot-messaging/discord-bot-messaging.service";
import { getRandomNumber } from "../utilities/getRandomNumber";
import { DiscordBotVoiceChannelsService } from "../discord-bot-voice-channels/discord-bot-voice-channels.service";
import { CachedDiscordUser } from "../types/CachedDiscordUser";

@Injectable()
export class DiscordPickPlayerService {
  private PlayerSelectionTimeoutSeconds = process.env.DEV ? 15 : 30;

  constructor(
    private readonly logger: Logger,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    private readonly bot: DiscordBotService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly discordBotMessaging: DiscordBotMessagingService,
    private readonly discordBotVoiceChannels: DiscordBotVoiceChannelsService,
  ) {}

  public async setAvailablePlayerPool(matchId: string, users: User[]) {
    const _users: Array<CachedDiscordUser> = users.map((user) => {
      return {
        id: user.id,
        username: user.username,
        globalName: user.globalName,
      };
    });

    await this.cache.put(this.getAvailableUsersCacheKey(matchId), _users);

    return _users;
  }

  public async getAvailablePlayerPool(
    matchId: string,
  ): Promise<ReturnType<this["setAvailablePlayerPool"]>> {
    return this.cache.get(this.getAvailableUsersCacheKey(matchId));
  }

  public async pickMember(matchId: string, lineupId: string, picks: number) {
    const match = await this.matchAssistant.getMatchLineups(matchId);

    const lineup =
      match.lineup_1.id == lineupId ? match.lineup_1 : match.lineup_2;
    const otherLineup =
      match.lineup_1.id == lineupId ? match.lineup_2 : match.lineup_1;

    const currentCaptain = lineup.lineup_players.find((player) => {
      return player.captain;
    });

    const otherCaptain = otherLineup.lineup_players.find((player) => {
      return player.captain;
    });

    if (!currentCaptain || !otherCaptain) {
      throw Error("Unable to find other captain");
    }

    const captain = await this.bot.client.users.fetch(
      currentCaptain.discord_id,
    );

    const otherCaptainDiscordUser = await this.bot.client.users.fetch(
      otherCaptain.discord_id,
    );

    const otherCaptainMessage = await otherCaptainDiscordUser.send(
      `Other captain is picking ${picks} ${picks > 1 ? "people" : "person"}`,
    );

    const users = await this.getAvailablePlayerPool(matchId);

    const pickedDiscordUserIds = match.lineup_players.map((player) => {
      return player.discord_id;
    });

    const availableUsers = users
      .filter((user) => {
        return !pickedDiscordUserIds.includes(user.id);
      })
      // we don't user actual player names cause the discord name may not match
      .map((user) => {
        return {
          value: user.id,
          label: getDiscordDisplayName(user),
        };
      });

    if (availableUsers.length === 0) {
      if (process.env.DEV) {
        await this.startVeto(matchId);

        return;
      }

      await this.discordBotMessaging.sendToMatchThread(
        matchId,
        "error: not enough users for team selection",
      );

      return;
    }

    let pickedUserIds: Array<string> = [];

    if (availableUsers.length === 1) {
      pickedUserIds.push(availableUsers[0].value);
    }

    let captainMessage: Message;

    if (pickedUserIds.length === 0) {
      const UserSelector = new StringSelectMenuBuilder({
        custom_id: "captain-select",
        placeholder: "Pick Player for your Team",
        minValues: picks,
        maxValues: picks,
      }).addOptions(availableUsers);

      captainMessage = await captain.send({
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            UserSelector,
          ),
        ],
      });

      try {
        const result =
          await captainMessage.awaitMessageComponent<ComponentType.StringSelect>(
            {
              time: this.PlayerSelectionTimeoutSeconds * 1000,
            },
          );

        pickedUserIds = result.values;
      } catch (error) {
        if (
          !error.message.includes(
            "Collector received no interactions before ending with reason: time",
          )
        ) {
          // TODO - we should be able to detect this.
          this.logger.warn(`[${matchId}] unable to send user to pick`, captain);
        }
        pickedUserIds = [];
        while (pickedUserIds.length < picks) {
          const { value } =
            availableUsers[getRandomNumber(0, availableUsers.length - 1)];
          if (!pickedUserIds.includes(value)) {
            pickedUserIds.push(value);
          }
        }
      }
    }

    const pickedUsers: Array<CachedDiscordUser> = [];
    for (const userId of pickedUserIds) {
      pickedDiscordUserIds.push(userId);

      const user = users.find((user) => {
        return user.id === userId;
      });

      await this.addDiscordUserToLineup(matchId, lineup.id, user);

      pickedUsers.push(user);
    }

    const pickedMsg = `picked ${pickedUsers.map((user) => {
      return getDiscordDisplayName(user);
    })}`;

    await this.discordBotMessaging.sendToMatchThread(
      matchId,
      `**${captain.globalName || captain.username}** ${pickedMsg}`,
    );

    if (captainMessage) {
      await captainMessage.edit({
        content: pickedMsg,
        components: [],
      });
    }

    await otherCaptainMessage.edit(
      `**${captain.globalName || captain.username}** ${pickedMsg}`,
    );

    if (
      (users.length < ExpectedPlayers[match.options.type] &&
        [...new Set(pickedDiscordUserIds)].length === users.length) ||
      [...new Set(pickedDiscordUserIds)].length ===
        ExpectedPlayers[match.options.type]
    ) {
      const mapVotingLink = `Map Voting is starting: ${await this.discordBotMessaging.getMatchReplyLink(
        matchId,
      )}`;
      await captain.send(mapVotingLink);
      await otherCaptainDiscordUser.send(mapVotingLink);

      await this.startVeto(matchId);

      return;
    }

    await this.pickMember(
      matchId,
      otherLineup.id,
      match.options.type === "Wingman"
        ? 1
        : /**
           * Pick Order: 1 -> 2 -> 1 by 1
           */
          // 3 because the 2 captains are in the total
          pickedDiscordUserIds.length === 3
          ? 2
          : 1,
    );
  }

  public async addDiscordUserToLineup(
    matchId: string,
    lineupId: string,
    user: CachedDiscordUser,
    captain = false,
  ) {
    const { players } = await this.hasura.query({
      players: {
        __args: {
          where: {
            discord_id: {
              _eq: user.id,
            },
          },
        },
        steam_id: true,
      },
    });

    const player = players.at(0);

    await this.hasura.mutation({
      insert_match_lineup_players_one: {
        __args: {
          object: {
            captain,
            discord_id: user.id,
            match_lineup_id: lineupId,
            steam_id: player?.steam_id,
            placeholder_name: !player ? getDiscordDisplayName(user) : undefined,
          },
        },
        __typename: true,
      },
    });

    await this.discordBotVoiceChannels.moveMemberToTeamChannel(
      matchId,
      lineupId,
      user,
    );
  }

  private async startVeto(matchId: string) {
    await this.cache.forget(this.getAvailableUsersCacheKey(matchId));

    await this.matchAssistant.updateMatchStatus(matchId, "Veto");
  }

  private getAvailableUsersCacheKey(matchId: string) {
    return `bot:${matchId}:users`;
  }
}
