import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import Redis from "ioredis";
import { e_notification_types_enum, e_player_roles_enum } from "generated";
import { PostgresService } from "src/postgres/postgres.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { NotificationsService } from "src/notifications/notifications.service";
import { PlayerBlocksService } from "src/player-blocks/player-blocks.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { User } from "../auth/types/User";
import { NewsCommentError } from "./enums/NewsCommentError";

type NewsCommentRow = {
  id: string;
  article_id: string;
  parent_id: string | null;
  author_steam_id: string;
  body: string;
  created_at: Date;
  deleted_at: Date | null;
  hidden_at: Date | null;
};

type NewsCommentArticle = {
  id: string;
  slug: string;
  title: string;
  status: string;
  open: boolean;
};

type NewsCommentPlayer = {
  steam_id: string;
  name: string;
  role: e_player_roles_enum;
  banned: boolean;
  gagged: boolean;
  muted: boolean;
};

export type NewsCommentOutput = { id: string; parent_id: string | null };

export type NewsCommentVoteOutput = {
  comment_id: string;
  vote_count: number;
  voted: boolean;
};

@Injectable()
export class NewsCommentsService {
  public static readonly MAX_LENGTH = 2000;
  public static readonly HIDE_REASON_MAX_LENGTH = 500;
  public static readonly EDIT_WINDOW_MS = 10 * 60_000;
  public static readonly POST_LIMIT_PER_MINUTE = 3;
  public static readonly POST_LIMIT_PER_DAY = 30;
  public static readonly EDIT_LIMIT_PER_MINUTE = 10;
  public static readonly VOTE_LIMIT_PER_MINUTE = 30;

  private static readonly MINUTE_MS = 60_000;
  private static readonly DAY_MS = 24 * 60 * 60_000;
  private static readonly SNIPPET_LENGTH = 140;

  private static readonly RATE_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;

  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    redisManager: RedisManagerService,
    private readonly notifications: NotificationsService,
    private readonly playerBlocks: PlayerBlocksService,
  ) {
    this.redis = redisManager.getConnection();
  }

  public async post(
    user: User | undefined,
    input: { article_id: string; parent_id?: string | null; body: string },
  ): Promise<NewsCommentOutput> {
    const author = await this.writer(user);
    const body = this.cleanBody(input.body);

    const article = await this.article(input.article_id);
    if (!article || article.status !== "published") {
      throw new NotFoundException(NewsCommentError.NotFound);
    }
    if (!article.open) {
      throw new BadRequestException(NewsCommentError.Closed);
    }

    let repliedTo: NewsCommentRow | null = null;
    if (input.parent_id) {
      repliedTo = await this.comment(input.parent_id);
      if (!repliedTo || repliedTo.article_id !== article.id) {
        throw new NotFoundException(NewsCommentError.NotFound);
      }

      const top = repliedTo.parent_id
        ? await this.comment(repliedTo.parent_id)
        : repliedTo;
      if (this.isRemoved(repliedTo) || !top || this.isRemoved(top)) {
        throw new BadRequestException(NewsCommentError.ParentRemoved);
      }
    }

    await this.withinRate(
      `news-comments:post:minute:${author.steam_id}`,
      NewsCommentsService.POST_LIMIT_PER_MINUTE,
      NewsCommentsService.MINUTE_MS,
      NewsCommentError.RateLimited,
    );
    await this.withinRate(
      `news-comments:post:day:${author.steam_id}`,
      NewsCommentsService.POST_LIMIT_PER_DAY,
      NewsCommentsService.DAY_MS,
      NewsCommentError.DailyLimit,
    );

    const [row] = await this.write<NewsCommentRow[]>(
      `INSERT INTO public.news_comments (article_id, parent_id, author_steam_id, body)
       VALUES ($1, $2, $3::bigint, $4)
       RETURNING *`,
      [article.id, repliedTo?.id ?? null, author.steam_id, body],
    );

    if (repliedTo) {
      await this.notifyReply(row, repliedTo, author, article).catch((error) => {
        this.logger.error(
          `unable to notify ${repliedTo.author_steam_id} of news comment reply ${row.id}`,
          error,
        );
      });
    }

    return { id: row.id, parent_id: row.parent_id };
  }

  public async edit(
    user: User | undefined,
    input: { id: string; body: string },
  ): Promise<NewsCommentOutput> {
    const author = await this.writer(user);
    const body = this.cleanBody(input.body);

    const comment = await this.comment(input.id);
    if (!comment) {
      throw new NotFoundException(NewsCommentError.NotFound);
    }
    if (String(comment.author_steam_id) !== author.steam_id) {
      throw new ForbiddenException(NewsCommentError.NotYours);
    }
    if (this.isRemoved(comment)) {
      throw new BadRequestException(NewsCommentError.Removed);
    }
    if (
      Date.now() >
      new Date(comment.created_at).getTime() + NewsCommentsService.EDIT_WINDOW_MS
    ) {
      throw new BadRequestException(NewsCommentError.EditWindow);
    }

    await this.withinRate(
      `news-comments:edit:minute:${author.steam_id}`,
      NewsCommentsService.EDIT_LIMIT_PER_MINUTE,
      NewsCommentsService.MINUTE_MS,
      NewsCommentError.RateLimited,
    );

    if (body !== comment.body) {
      await this.write(
        `UPDATE public.news_comments SET body = $2 WHERE id = $1`,
        [comment.id, body],
      );
    }

    return { id: comment.id, parent_id: comment.parent_id };
  }

  // A comment nobody answered goes for good; one with replies leaves a
  // placeholder so they keep their place, until the last of them goes too.
  public async remove(
    user: User | undefined,
    input: { id: string },
  ): Promise<{ success: boolean }> {
    const actor = await this.player(user);

    const comment = await this.comment(input.id);
    if (!comment) {
      throw new NotFoundException(NewsCommentError.NotFound);
    }

    const own = String(comment.author_steam_id) === actor.steam_id;
    if (!own && !isRoleAbove(actor.role, "moderator")) {
      throw new ForbiddenException(NewsCommentError.NotYours);
    }

    const deleted = await this.write<Array<{ id: string }>>(
      `DELETE FROM public.news_comments c
        WHERE c.id = $1
          AND NOT EXISTS (
              SELECT 1 FROM public.news_comments r WHERE r.parent_id = c.id
          )
        RETURNING c.id`,
      [comment.id],
    );

    if (deleted.length === 0) {
      await this.write(
        `UPDATE public.news_comments
            SET deleted_at = now(), deleted_by_staff = $2
          WHERE id = $1 AND deleted_at IS NULL`,
        [comment.id, !own],
      );
    } else if (comment.parent_id) {
      await this.write(
        `DELETE FROM public.news_comments p
          WHERE p.id = $1
            AND p.deleted_at IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM public.news_comments r WHERE r.parent_id = p.id
            )`,
        [comment.parent_id],
      );
    }

    if (!own) {
      this.logger.log(
        `news comment ${comment.id} by ${comment.author_steam_id} deleted by ${actor.steam_id}`,
      );
    }

    return { success: true };
  }

  public async toggleVote(
    user: User | undefined,
    input: { id: string },
  ): Promise<NewsCommentVoteOutput> {
    const voter = await this.player(user);
    if (!isRoleAbove(voter.role, "verified_user")) {
      throw new ForbiddenException(NewsCommentError.NotVerified);
    }

    const comment = await this.comment(input.id);
    if (!comment) {
      throw new NotFoundException(NewsCommentError.NotFound);
    }
    if (String(comment.author_steam_id) === voter.steam_id) {
      throw new BadRequestException(NewsCommentError.OwnVote);
    }
    if (this.isRemoved(comment)) {
      throw new BadRequestException(NewsCommentError.Removed);
    }

    const article = await this.article(comment.article_id);
    if (!article?.open) {
      throw new BadRequestException(NewsCommentError.Closed);
    }

    const [existing] = await this.postgres.query<Array<{ voted: boolean }>>(
      `SELECT true AS voted
         FROM public.news_comment_votes
        WHERE comment_id = $1 AND steam_id = $2::bigint`,
      [comment.id, voter.steam_id],
    );

    if (!existing) {
      this.assertNotSanctioned(voter);
    }

    await this.withinRate(
      `news-comments:vote:minute:${voter.steam_id}`,
      NewsCommentsService.VOTE_LIMIT_PER_MINUTE,
      NewsCommentsService.MINUTE_MS,
      NewsCommentError.RateLimited,
    );

    if (existing) {
      await this.write(
        `DELETE FROM public.news_comment_votes
          WHERE comment_id = $1 AND steam_id = $2::bigint`,
        [comment.id, voter.steam_id],
      );
    } else {
      await this.write(
        `INSERT INTO public.news_comment_votes (comment_id, steam_id)
         VALUES ($1, $2::bigint)
         ON CONFLICT (comment_id, steam_id) DO NOTHING`,
        [comment.id, voter.steam_id],
      );
    }

    const [{ vote_count }] = await this.postgres.query<
      Array<{ vote_count: number }>
    >(`SELECT vote_count FROM public.news_comments WHERE id = $1`, [
      comment.id,
    ]);

    return {
      comment_id: comment.id,
      vote_count: Number(vote_count),
      voted: !existing,
    };
  }

  public async setHidden(
    user: User | undefined,
    input: { id: string; hidden: boolean; reason?: string | null },
  ): Promise<NewsCommentOutput> {
    const moderator = await this.player(user);
    if (!isRoleAbove(moderator.role, "moderator")) {
      throw new ForbiddenException(NewsCommentError.StaffOnly);
    }

    const comment = await this.comment(input.id);
    if (!comment) {
      throw new NotFoundException(NewsCommentError.NotFound);
    }
    if (comment.deleted_at) {
      throw new BadRequestException(NewsCommentError.Removed);
    }

    if (input.hidden) {
      const reason =
        (input.reason ?? "")
          .trim()
          .slice(0, NewsCommentsService.HIDE_REASON_MAX_LENGTH) || null;

      await this.write(
        `UPDATE public.news_comments
            SET hidden_at = COALESCE(hidden_at, now()),
                hidden_by_steam_id = $2::bigint,
                hidden_reason = $3
          WHERE id = $1`,
        [comment.id, moderator.steam_id, reason],
      );
    } else {
      await this.write(
        `UPDATE public.news_comments
            SET hidden_at = NULL, hidden_by_steam_id = NULL, hidden_reason = NULL
          WHERE id = $1`,
        [comment.id],
      );
    }

    this.logger.log(
      `news comment ${comment.id} ${input.hidden ? "hidden" : "restored"} by ${moderator.steam_id}`,
    );

    return { id: comment.id, parent_id: comment.parent_id };
  }

  // The player who was replied to, not whoever started the thread: a reply to
  // a reply is stored under the top-level comment but answers its own parent.
  private async notifyReply(
    reply: NewsCommentRow,
    repliedTo: NewsCommentRow,
    replier: NewsCommentPlayer,
    article: NewsCommentArticle,
  ): Promise<void> {
    const recipient = String(repliedTo.author_steam_id);

    if (recipient === replier.steam_id) {
      return;
    }

    if (await this.playerBlocks.hasBlocked(recipient, replier.steam_id)) {
      return;
    }

    const snippet =
      reply.body.length > NewsCommentsService.SNIPPET_LENGTH
        ? `${reply.body.slice(0, NewsCommentsService.SNIPPET_LENGTH - 1)}…`
        : reply.body;
    const link = `/news/${encodeURIComponent(article.slug)}#comment-${reply.id}`;

    await this.notifications.notifyPlayers(
      "NewsCommentReply" as e_notification_types_enum,
      {
        title: `${replier.name} replied to your comment`,
        message:
          `On <a href="${NotificationsService.escapeHtml(link)}">` +
          `${NotificationsService.escapeHtml(article.title)}</a>: ` +
          `“${NotificationsService.escapeHtml(snippet)}”`,
        role: "user",
        entity_id: reply.id,
        steamIds: [recipient],
      },
    );
  }

  private async player(user?: User): Promise<NewsCommentPlayer> {
    if (!user?.steam_id) {
      throw new ForbiddenException(NewsCommentError.SignIn);
    }

    const [player] = await this.postgres.query<NewsCommentPlayer[]>(
      `SELECT p.steam_id::text AS steam_id,
              p.name,
              p.role,
              public.is_banned(p) AS banned,
              public.is_gagged(p) AS gagged,
              public.is_muted(p) AS muted
         FROM public.players p
        WHERE p.steam_id = $1::bigint`,
      [String(user.steam_id)],
    );

    if (!player) {
      throw new ForbiddenException(NewsCommentError.SignIn);
    }

    return player;
  }

  private async writer(user?: User): Promise<NewsCommentPlayer> {
    const player = await this.player(user);

    if (!isRoleAbove(player.role, "verified_user")) {
      throw new ForbiddenException(NewsCommentError.NotVerified);
    }

    this.assertNotSanctioned(player);

    return player;
  }

  private assertNotSanctioned(player: NewsCommentPlayer): void {
    if (player.banned) {
      throw new ForbiddenException(NewsCommentError.Banned);
    }
    if (player.gagged) {
      throw new ForbiddenException(NewsCommentError.Gagged);
    }
    if (player.muted) {
      throw new ForbiddenException(NewsCommentError.Muted);
    }
  }

  private cleanBody(body: string | null | undefined): string {
    const text = String(body ?? "")
      .replace(/\r\n?/g, "\n")
      .trim();

    if (!text) {
      throw new BadRequestException(NewsCommentError.Empty);
    }
    if (text.length > NewsCommentsService.MAX_LENGTH) {
      throw new BadRequestException(NewsCommentError.TooLong);
    }

    return text;
  }

  private isRemoved(comment: NewsCommentRow): boolean {
    return !!comment.deleted_at || !!comment.hidden_at;
  }

  private async withinRate(
    key: string,
    limit: number,
    windowMs: number,
    error: NewsCommentError,
  ): Promise<void> {
    const count = await this.redis.eval(
      NewsCommentsService.RATE_SCRIPT,
      1,
      key,
      windowMs,
    );

    if (Number(count) > limit) {
      throw new BadRequestException(error);
    }
  }

  private async article(id: string): Promise<NewsCommentArticle | null> {
    const [row] = await this.postgres.query<NewsCommentArticle[]>(
      `SELECT id, slug, title, status, public.news_comments_open(id) AS open
         FROM public.news_articles
        WHERE id = $1`,
      [id],
    );

    return row ?? null;
  }

  private async comment(id: string): Promise<NewsCommentRow | null> {
    const [row] = await this.postgres.query<NewsCommentRow[]>(
      `SELECT id, article_id, parent_id, author_steam_id::text AS author_steam_id,
              body, created_at, deleted_at, hidden_at
         FROM public.news_comments
        WHERE id = $1`,
      [id],
    );

    return row ?? null;
  }

  // The triggers raise SQLSTATE 22023 with a NewsCommentError as the message,
  // for a rule a concurrent write broke after the checks above passed.
  private async write<T = unknown>(
    sql: string,
    params: Parameters<PostgresService["query"]>[1],
  ): Promise<T> {
    try {
      return await this.postgres.query<T>(sql, params);
    } catch (error) {
      if ((error as { code?: string })?.code === "22023") {
        throw new BadRequestException((error as Error).message);
      }
      throw error;
    }
  }
}
