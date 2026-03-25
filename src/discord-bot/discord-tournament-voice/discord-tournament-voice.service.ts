import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { CategoryChannel, ChannelType, PermissionsBitField } from "discord.js";
import { CacheService } from "../../cache/cache.service";
import { HasuraService } from "../../hasura/hasura.service";
import { DiscordBotService } from "../discord-bot.service";
import { DiscordBotMessagingService } from "../discord-bot-messaging/discord-bot-messaging.service";
import { DiscordBotVoiceChannelsService } from "../discord-bot-voice-channels/discord-bot-voice-channels.service";
import { getBracketRoundLabel } from "./utilities/getBracketRoundLabel";

interface TournamentVoiceCache {
  guildId: string;
  categoryId: string;
  readyRoomId: string;
}

@Injectable()
export class DiscordTournamentVoiceService {
  constructor(
    private readonly logger: Logger,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
    @Inject(forwardRef(() => DiscordBotService))
    private readonly bot: DiscordBotService,
    @Inject(forwardRef(() => DiscordBotMessagingService))
    private readonly messaging: DiscordBotMessagingService,
    @Inject(forwardRef(() => DiscordBotVoiceChannelsService))
    private readonly voiceChannels: DiscordBotVoiceChannelsService,
  ) {}

  public async createTournamentReadyRoom(tournamentId: string) {
    const { tournaments_by_pk: tournament } = await this.hasura.query({
      tournaments_by_pk: {
        __args: {
          id: tournamentId,
        },
        discord_guild_id: true,
        discord_voice_enabled: true,
        name: true,
      },
    });

    if (
      !tournament ||
      !tournament.discord_voice_enabled ||
      !tournament.discord_guild_id
    ) {
      return;
    }

    const guildId = tournament.discord_guild_id as string;
    const tournamentName = tournament.name as string;

    const existing = await this.getVoiceCache(tournamentId);
    if (existing) {
      return;
    }

    try {
      const guild = await this.bot.client.guilds.fetch(guildId);

      const category = await guild.channels.create({
        name: tournamentName,
        type: ChannelType.GuildCategory,
      });

      const readyRoom = await guild.channels.create({
        name: "Ready Room",
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [
          {
            id: guild.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.Connect,
            ],
            deny: [PermissionsBitField.Flags.Speak],
          },
          {
            id: this.bot.client.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.Connect,
              PermissionsBitField.Flags.Speak,
              PermissionsBitField.Flags.MoveMembers,
              PermissionsBitField.Flags.ManageChannels,
            ],
          },
        ],
      });

      await this.setVoiceCache(tournamentId, {
        guildId,
        categoryId: category.id,
        readyRoomId: readyRoom.id,
      });

      this.logger.log(
        `[${tournamentId}] created tournament ready room and category`,
      );
    } catch (error) {
      this.logger.error(
        `[${tournamentId}] failed to create tournament ready room`,
        error,
      );
    }
  }

  public async createMatchVoiceChannels(matchId: string) {
    const { tournament_brackets } = await this.hasura.query({
      tournament_brackets: {
        __args: {
          where: {
            match_id: { _eq: matchId },
          },
          limit: 1,
        },
        round: true,
        path: true,
        group: true,
        match_number: true,
        stage: {
          type: true,
          order: true,
          max_teams: true,
          groups: true,
          tournament_id: true,
          tournament: {
            discord_voice_enabled: true,
            discord_guild_id: true,
            stages: {
              order: true,
            },
          },
        },
        match: {
          lineup_1: {
            id: true,
            name: true,
          },
          lineup_2: {
            id: true,
            name: true,
          },
        },
      },
    });

    const bracket = tournament_brackets?.at(0);
    if (!bracket?.stage?.tournament?.discord_voice_enabled) {
      return;
    }

    const tournamentId = bracket.stage.tournament_id as string;
    const voiceCache = await this.getVoiceCache(tournamentId);

    if (!voiceCache) {
      this.logger.warn(
        `[${matchId}] no tournament voice cache found for tournament ${tournamentId}`,
      );
      return;
    }

    const lineup1 = bracket.match?.lineup_1;

    const existingMatchVoice = await this.voiceChannels.getVoiceCache(
      matchId,
      lineup1?.id as string,
    );
    if (existingMatchVoice) {
      return; // Already created (e.g., from WaitingForCheckIn trigger)
    }

    const totalStages = bracket.stage.tournament.stages?.length || 1;
    const stageOrder = bracket.stage.order as number;
    const bracketRound = bracket.round as number;
    const bracketPath = bracket.path as string | null;
    const stageType = bracket.stage.type as string | null;
    const isFinalStage = stageOrder === totalStages;

    const bracketsInSameRound = await this.hasura.query({
      tournament_brackets_aggregate: {
        __args: {
          where: {
            stage: {
              tournament_id: { _eq: tournamentId },
              order: { _eq: stageOrder },
            },
            round: { _eq: bracketRound },
            path: { _eq: bracketPath },
          },
        },
        aggregate: {
          count: true,
        },
      },
    });

    const totalMatchesInRound =
      (bracketsInSameRound.tournament_brackets_aggregate.aggregate
        .count as number) || 1;

    const maxRound = await this.hasura.query({
      tournament_brackets_aggregate: {
        __args: {
          where: {
            stage: {
              tournament_id: { _eq: tournamentId },
              order: { _eq: stageOrder },
            },
            path: { _eq: bracketPath },
          },
        },
        aggregate: {
          max: {
            round: true,
          },
        },
      },
    });

    const highestRound =
      (maxRound.tournament_brackets_aggregate.aggregate.max?.round as number) ||
      bracketRound;
    const isLastRound = bracketRound === highestRound;
    const isLoserBracket = bracketPath === "loser";

    const roundLabel = getBracketRoundLabel(
      bracketRound,
      stageOrder,
      isFinalStage,
      totalMatchesInRound,
      isLoserBracket,
      stageType,
      isLastRound,
    );

    const lineup2 = bracket.match?.lineup_2;

    if (!lineup1 || !lineup2) {
      this.logger.warn(`[${matchId}] match lineups not found`);
      return;
    }

    try {
      const team1Name = (lineup1.name as string) || "Team 1";
      const team2Name = (lineup2.name as string) || "Team 2";

      await this.voiceChannels.createMatchVoiceChannel(
        matchId,
        voiceCache.guildId,
        voiceCache.readyRoomId,
        voiceCache.categoryId,
        lineup1.id as string,
        `${team1Name} - ${roundLabel}`,
      );

      await this.voiceChannels.createMatchVoiceChannel(
        matchId,
        voiceCache.guildId,
        voiceCache.readyRoomId,
        voiceCache.categoryId,
        lineup2.id as string,
        `${team2Name} - ${roundLabel}`,
      );

      this.logger.log(
        `[${matchId}] created tournament match voice channels for ${roundLabel}`,
      );
    } catch (error) {
      this.logger.error(
        `[${matchId}] failed to create tournament match voice channels`,
        error,
      );
    }
  }

  public async movePlayersToMatchChannels(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        lineup_1: {
          id: true,
          lineup_players: {
            steam_id: true,
            player: {
              discord_id: true,
              name: true,
            },
          },
        },
        lineup_2: {
          id: true,
          lineup_players: {
            steam_id: true,
            player: {
              discord_id: true,
              name: true,
            },
          },
        },
      },
    });

    if (!match) {
      return;
    }

    const unlinkedPlayers: string[] = [];

    for (const lineup of [match.lineup_1, match.lineup_2]) {
      for (const lineupPlayer of lineup.lineup_players) {
        const discordId = lineupPlayer.player?.discord_id as string | undefined;
        const playerName = lineupPlayer.player?.name as string | undefined;

        if (!discordId) {
          unlinkedPlayers.push(playerName || (lineupPlayer.steam_id as string));
          continue;
        }

        try {
          await this.voiceChannels.moveMemberToTeamChannel(
            matchId,
            lineup.id as string,
            {
              id: discordId,
              username: playerName || "Unknown",
              globalName: playerName || "Unknown",
            },
          );
        } catch (error) {
          this.logger.warn(
            `[${matchId}] failed to move player ${lineupPlayer.steam_id} to voice channel`,
            error,
          );
        }
      }
    }

    if (unlinkedPlayers.length > 0) {
      try {
        await this.messaging.sendToMatchThread(matchId, {
          content: `The following players do not have Discord linked and could not be moved to voice channels: ${unlinkedPlayers.join(", ")}`,
        });
      } catch (error) {
        this.logger.warn(
          `[${matchId}] failed to send unlinked players warning`,
          error,
        );
      }
    }
  }

  public async removeTournamentVoice(tournamentId: string) {
    const voiceCache = await this.getVoiceCache(tournamentId);

    if (!voiceCache) {
      return;
    }

    try {
      const guild = await this.bot.client.guilds.fetch(voiceCache.guildId);

      try {
        const category = await guild.channels.fetch(voiceCache.categoryId);
        if (category && category.type === ChannelType.GuildCategory) {
          for (const [, child] of (category as CategoryChannel).children
            .cache) {
            await child.delete().catch(() => {});
          }
          await category.delete();
        }
      } catch (error) {
        this.logger.warn(`[${tournamentId}] unable to delete category`, error);
      }

      await this.cache.forget(this.getVoiceCacheKey(tournamentId));

      this.logger.log(`[${tournamentId}] removed tournament voice channels`);
    } catch (error) {
      this.logger.error(
        `[${tournamentId}] failed to remove tournament voice channels`,
        error,
      );
    }
  }

  private async getVoiceCache(
    tournamentId: string,
  ): Promise<TournamentVoiceCache | null> {
    return await this.cache.get(this.getVoiceCacheKey(tournamentId));
  }

  private async setVoiceCache(
    tournamentId: string,
    data: TournamentVoiceCache,
  ) {
    await this.cache.put(
      this.getVoiceCacheKey(tournamentId),
      data,
      30 * 24 * 60 * 60,
    );
  }

  private getVoiceCacheKey(tournamentId: string) {
    return `tournament:${tournamentId}:voice`;
  }
}
