import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import {
  ActionRowBuilder,
  ComponentType,
  StringSelectMenuInteraction,
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
  private PlayerSelectionTimeoutSeconds = 30;

  constructor(
    private readonly logger: Logger,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    @Inject(forwardRef(() => DiscordBotService))
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

    const pickingLineup =
      match.lineup_1.id == lineupId ? match.lineup_1 : match.lineup_2;

    const currentCaptain = pickingLineup.lineup_players.find((player) => {
      return player.captain;
    });

    if (!currentCaptain) {
      throw Error("Unable to find captain");
    }

    const captain = await this.bot.client.users.fetch(
      currentCaptain.discord_id,
    );

    if (!captain) {
      throw Error("Unable to find captain");
    }

    const matchThread = await this.discordBotMessaging.getMatchThread(matchId);

    if (!matchThread) {
      throw Error("Unable to find match thread");
    }

    const users = await this.getAvailablePlayerPool(matchId);

    const pickedDiscordUserIds = match.lineup_players.map((player) => {
      return player.discord_id;
    });

    const availableUsers = users
      .filter((user) => {
        return !pickedDiscordUserIds.includes(user.id);
      })
      .map((user) => {
        return {
          value: user.id,
          label: getDiscordDisplayName(user),
        };
      });

    if (availableUsers.length === 0) {
      if (process.env.DEV) {
        await this.startMatch(matchId);

        return;
      }

      await this.discordBotMessaging.sendToMatchThread(
        matchId,
        "error: not enough players for team selection",
      );

      return;
    }

    let pickedUserIds: Array<string> = [];

    if (availableUsers.length === 1) {
      pickedUserIds.push(availableUsers.at(0).value);
    } else {
      pickedUserIds = await this.captainPick(
        picks,
        availableUsers,
        captain,
        matchId,
      );
    }

    const pickedUsers: Array<CachedDiscordUser> = [];
    for (const userId of pickedUserIds) {
      pickedDiscordUserIds.push(userId);

      const user = users.find((user) => {
        return user.id === userId;
      });

      await this.addDiscordUserToLineup(matchId, pickingLineup.id, user);

      pickedUsers.push(user);
    }

    await this.discordBotMessaging.sendToMatchThread(
      matchId,
      `**${captain.globalName || captain.username}** ${`picked ${pickedUsers.map(
        (user) => {
          return getDiscordDisplayName(user);
        },
      )}`}`,
    );

    if (
      (users.length < ExpectedPlayers[match.options.type] &&
        [...new Set(pickedDiscordUserIds)].length === users.length) ||
      [...new Set(pickedDiscordUserIds)].length ===
        ExpectedPlayers[match.options.type]
    ) {
      await this.startMatch(matchId);

      return;
    }

    await this.pickMember(
      matchId,
      pickingLineup.id === match.lineup_1.id
        ? match.lineup_2.id
        : match.lineup_1.id,
      match.options.type != "Competitive"
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

  private async captainPick(
    picks: number,
    availableUsers: Array<{ value: string; label: string }>,
    captain: CachedDiscordUser,
    matchId: string,
  ) {
    let pickedUserIds: string[] = [];

    const pickingReply = await this.discordBotMessaging.updateMatchReply(
      matchId,
      {
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder({
              custom_id: "captain-select",
              placeholder: `It's ${getDiscordDisplayName(captain)}'s turn to pick a player for their team`,
              minValues: picks,
              maxValues: picks,
            }).addOptions(availableUsers),
          ),
        ],
      },
    );

    try {
      const result =
        await pickingReply.awaitMessageComponent<ComponentType.StringSelect>({
          time: this.PlayerSelectionTimeoutSeconds * 1000,
          componentType: ComponentType.StringSelect,
          filter: (interaction: StringSelectMenuInteraction) => {
            if (interaction.user.id !== captain.id) {
              // Politely inform non-captains they cannot pick
              interaction
                .reply({
                  content: "It's not your turn to pick.",
                  ephemeral: true,
                })
                .catch(() => {});
              return false;
            }
            return true;
          },
        });

      await result.deferUpdate().catch(() => {
        this.logger.log("Unable to defer update");
      });
      pickedUserIds = result.values;
    } catch (error) {
      if (
        !error.message.includes(
          "Collector received no interactions before ending with reason: time",
        )
      ) {
        this.logger.warn(`[${matchId}] unable to send user to pick`);
      }
      while (pickedUserIds.length < picks) {
        const { value } =
          availableUsers[getRandomNumber(0, availableUsers.length - 1)];
        if (!pickedUserIds.includes(value)) {
          pickedUserIds.push(value);
        }
      }
    }

    return pickedUserIds;
  }

  public async addDiscordUserToLineup(
    matchId: string,
    lineupId: string,
    user: CachedDiscordUser,
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

  public async startMatch(matchId: string) {
    await this.cache.forget(this.getAvailableUsersCacheKey(matchId));

    await this.matchAssistant.updateMatchStatus(
      matchId,
      await this.matchAssistant.getNextPhase(matchId),
    );
  }

  private getAvailableUsersCacheKey(matchId: string) {
    return `bot:${matchId}:users`;
  }
}
