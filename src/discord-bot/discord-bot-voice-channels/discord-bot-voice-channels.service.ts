import { Injectable } from "@nestjs/common";
import { ChannelType, GuildChannel, User, VoiceChannel } from "discord.js";
import { CacheService } from "../../cache/cache.service";
import { CacheTag } from "../../cache/CacheTag";
import { DiscordBotService } from "../discord-bot.service";

@Injectable()
export class DiscordBotVoiceChannelsService {
  constructor(
    private readonly cache: CacheService,
    private readonly bot: DiscordBotService
  ) {}

  public async createMatchVoiceChannel(
    matchId: string,
    guildId: string,
    originalChannelId: string,
    categoryChannelId: string,
    lineupId: string
  ) {
    const guild = await this.getGuild(guildId);

    const voiceChannel = (await guild.channels.create({
      name: `${lineupId} [${matchId}]`,
      parent: categoryChannelId,
      type: ChannelType.GuildVoice,
    })) as VoiceChannel;

    await this.setVoiceCache(
      matchId,
      lineupId,
      originalChannelId,
      voiceChannel.id,
      voiceChannel.guildId
    );
  }

  public async setVoiceCache(
    matchId: string,
    lineupId: string,
    originalChannelId: string,
    voiceChannelId: string,
    guildId: string
  ) {
    const voiceChannelData = {
      guildId: guildId,
      originalChannelId,
      voiceChannelId: voiceChannelId,
    };

    await this.cache.put(
      this.getLineupVoiceChannelCacheKey(matchId, lineupId),
      voiceChannelData
    );

    const tag = this.cache.tags(
      this.getLineupVoiceChannelsCacheKey(matchId)
    ) as CacheTag;

    await tag.put(lineupId, {
      guildId,
      voiceChannelId,
      originalChannelId,
    });

    return voiceChannelData;
  }

  public async getVoiceCache(
    matchId: string,
    lineupId: string
  ): Promise<ReturnType<this["setVoiceCache"]>> {
    return await this.cache.get(
      this.getLineupVoiceChannelCacheKey(matchId, lineupId)
    );
  }

  public async moveMemberToTeamChannel(
    matchId: string,
    lineupId: string,
    user: User
  ) {
    try {
      const voiceCache = await this.getVoiceCache(matchId, lineupId);

      const guild = await this.getGuild(voiceCache.guildId);

      const member = await guild.members.fetch(user.id);

      if (!voiceCache.originalChannelId) {
        return;
      }

      await member.voice.setChannel(voiceCache.voiceChannelId);
    } catch (error) {
      console.warn(`[${matchId}] unable to move user`, error);
    }
  }

  private async getGuild(guildId: string) {
    return await this.bot.client.guilds.fetch(guildId);
  }

  public async removeTeamChannels(matchId: string) {
    try {
      const tag = this.cache.tags(
        this.getLineupVoiceChannelsCacheKey(matchId)
      ) as CacheTag;

      const lineupVoiceChannels = (await tag.get()) as Record<
        string,
        {
          guildId: string;
          voiceChannelId: string;
          originalChannelId: string;
        }
      >;

      for (const lineupId in lineupVoiceChannels) {
        const {
          guildId,
          voiceChannelId,
          originalChannelId,
        } = lineupVoiceChannels[lineupId];

        const guild = await this.getGuild(guildId);
        if (!guild) {
          return;
        }

        const channel = (await guild.channels.fetch(
          voiceChannelId
        )) as GuildChannel;

        for (const [, member] of channel.members) {
          await member.voice.setChannel(originalChannelId).catch((error) => {
            // do nothing as the member may have moved already
            console.warn(`[${matchId}] unable to move player back`, error);
          });
        }

        setTimeout(async () => {
          await this.cache.forget(
            this.getLineupVoiceChannelCacheKey(matchId, lineupId)
          );

          await channel.delete().catch((error) => {
            // do nothing as it may have been deleted already
            console.warn(`[${matchId}] unable to delete voice channel`, error);
          });
        }, 5 * 1000);
      }

      await tag.forget();
    } catch (error) {
      console.warn(
        `[${matchId}] unable to remove team channels`,
        error.message
      );
    }
  }

  private getLineupVoiceChannelCacheKey(matchId: string, lineupId: string) {
    return `match:${matchId}:${lineupId}:voice`;
  }

  private getLineupVoiceChannelsCacheKey(matchId: string) {
    return `match:${matchId}:voice-channels`.split(":");
  }
}
