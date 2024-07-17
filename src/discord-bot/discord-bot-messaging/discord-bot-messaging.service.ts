import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../../cache/cache.service";
import { DiscordBotService } from "../discord-bot.service";
import {
  AnyThreadChannel,
  ChatInputCommandInteraction,
  Message,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from "discord.js";

@Injectable()
export class DiscordBotMessagingService {
  constructor(
    private readonly logger: Logger,
    private readonly cache: CacheService,
    private readonly bot: DiscordBotService,
  ) {}

  public async getMatchThread(matchId: string) {
    const threadCache = await this.getMatchThreadCache(matchId);

    if (!threadCache) {
      return;
    }

    const guild = await this.bot.client.guilds.fetch(threadCache.guildId);
    return (await guild.channels.fetch(threadCache.threadId)) as ThreadChannel;
  }

  public async removeMatchReply(matchId: string) {
    try {
      const reply = await this.getMatchReply(matchId);
      if (!reply) {
        this.logger.warn(`[${matchId}] missing thread`);
        return;
      }
      await reply.delete();

      await this.forgetMatchReplyCache(matchId);
      await this.forgetMatchThreadCache(matchId);
    } catch (error) {
      this.logger.warn(`[${matchId}] unable to remove thread`, error.message);
    }
  }

  private async getMatchReply(matchId: string): Promise<Message | void> {
    const replyCache = await this.getMatchReplyCache(matchId);

    if (!replyCache) {
      return;
    }

    const { replyId, channelId, guildId } = replyCache;

    if (!guildId) {
      return;
    }

    const guild = await this.bot.client.guilds.fetch(guildId);

    const channel = await guild.channels.fetch(channelId);

    if (!channel.isTextBased()) {
      return;
    }

    return await channel.messages.fetch(replyId);
  }

  public async getMatchReplyLink(matchId: string) {
    const reply = await this.getMatchReply(matchId);

    if (!reply) {
      throw Error("unable to get reply link");
    }

    return reply.url;
  }

  public async sendInitialReply(
    interaction: ChatInputCommandInteraction,
    matchId: string,
  ) {
    const reply = await interaction.followUp({
      fetchReply: true,
      content: `Match Created: ${matchId}`,
    });

    await this.setMatchReplyCache(matchId, reply);
  }

  public async setMatchReplyCache(matchId: string, reply: Message) {
    const replyCache = {
      replyId: reply.id,
      guildId: reply.guildId,
      channelId: reply.channelId,
    };
    await this.cache.put(this.getMatchReplyCacheKey(matchId), replyCache);

    return replyCache;
  }

  public async forgetMatchReplyCache(matchId: string) {
    await this.cache.forget(this.getMatchReplyCacheKey(matchId));
  }

  public async getMatchReplyCache(
    matchId: string,
  ): Promise<ReturnType<this["setMatchReplyCache"]>> {
    return await this.cache.get(this.getMatchReplyCacheKey(matchId));
  }

  public async setMatchThreadCache(matchId: string, thread: AnyThreadChannel) {
    const threadCache = {
      threadId: thread.id,
      guildId: thread.guildId,
    };

    await this.cache.put(this.getMatchThreadCacheKey(matchId), threadCache);

    return threadCache;
  }

  public async forgetMatchThreadCache(matchId: string) {
    await this.cache.forget(this.getMatchThreadCacheKey(matchId));
  }

  public async getMatchThreadCache(
    matchId: string,
  ): Promise<ReturnType<this["setMatchThreadCache"]>> {
    return await this.cache.get(this.getMatchThreadCacheKey(matchId));
  }

  public async updateMatchReply(
    matchId: string,
    ...[options]: Parameters<Message["edit"]>
  ) {
    const reply = await this.getMatchReply(matchId);

    if (!reply) {
      return;
    }

    return reply.edit(options);
  }

  public async sendToMatchThread(
    matchId: string,
    ...[options]: Parameters<ThreadChannel["send"]>
  ) {
    const thread = await this.getMatchThread(matchId);

    if (!thread) {
      this.logger.warn(`[${matchId}] unable to get thread`);
      return;
    }

    await thread.send(options);
  }

  public async createMatchThread(matchId: string) {
    const reply = await this.getMatchReply(matchId);
    if (!reply) {
      return;
    }

    const thread = await reply.startThread({
      name: `Scrim Match ${matchId}`,
      reason: `Scrim Match ${matchId}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });

    await this.setMatchThreadCache(matchId, thread);

    return thread;
  }

  private getMatchReplyCacheKey(matchId: string) {
    return `bot:${matchId}:reply`;
  }

  private getMatchThreadCacheKey(matchId: string) {
    return `bot:${matchId}:thread`;
  }
}
