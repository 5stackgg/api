import { readFileSync } from "fs";
import { join, resolve } from "path";
import { load } from "cheerio";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import * as webPush from "web-push";
import { PostgresService } from "../src/postgres/postgres.service";
import { PlayerBlocksService } from "../src/player-blocks/player-blocks.service";
import { NewsCommentsService } from "../src/news/news-comments.service";
import { NewsCommentError } from "../src/news/enums/NewsCommentError";
import { User } from "../src/auth/types/User";
import { stripHtml } from "../src/notifications/utilities/stripHtml";
import { notificationUrl } from "../src/notifications/utilities/notificationUrl";
import { NotificationsService } from "../src/notifications/notifications.service";
import { NotificationPreferencesService } from "../src/notifications/preferences/notification-preferences.service";
import { PushNotificationsService } from "../src/notifications/push/push-notifications.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));

// Comments under a published news post: who may write, the 7-day window, one
// level of replies, staff moderation, limits, what each reader is shown and
// the reply notification. Against real Postgres, so the triggers and the
// computed fields Hasura reads are the ones being tested.
describe("news comments (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let service: NewsCommentsService;
  let container: StartedTestContainer;
  let redis: Redis;
  let push: PushNotificationsService;
  let trailing: jest.Mock;
  let notifyPlayers: jest.SpyInstance;
  let seq = 0;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeAll(async () => {
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });

    db = await bootMigratedDb("NewsCommentsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199965000000n);
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
    await db?.stop();
  });

  // notifyPlayers writes through Hasura; this lands the rows in the table the
  // push gate then reads them back from.
  const hasura = () => ({
    query: jest.fn().mockResolvedValue({ settings_by_pk: null }),
    mutation: jest.fn(async (mutation: any) => {
      const insert = mutation?.insert_notifications;
      const returning: Array<{ id: string }> = [];

      for (const object of insert?.__args.objects ?? []) {
        const [row] = await postgres.query<Array<{ id: string }>>(
          `INSERT INTO notifications (type, title, message, role, steam_id, entity_id, in_app, data)
           VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8::jsonb)
           RETURNING id::text AS id`,
          [
            object.type,
            object.title,
            object.message,
            object.role,
            object.steam_id,
            object.entity_id ?? null,
            object.in_app ?? true,
            object.data ? JSON.stringify(object.data) : null,
          ],
        );
        returning.push(row);
      }

      return { insert_notifications: { returning } };
    }),
  });

  beforeEach(async () => {
    await postgres.query("TRUNCATE news_comment_votes, news_comments");
    await postgres.query("DELETE FROM news_articles");
    await postgres.query("DELETE FROM player_blocks");
    await postgres.query("DELETE FROM player_sanctions");
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM push_subscriptions");
    await redis.flushdb();
    (webPush.sendNotification as jest.Mock).mockClear();

    trailing = jest.fn(async () => ({}));
    push = new PushNotificationsService(
      logger as any,
      postgres,
      {
        get: (key: string) =>
          key === "app"
            ? { webDomain: "https://5stack.test", apiDomain: "api.5stack.test" }
            : {
                publicKey: "public-key",
                privateKey: "private-key",
                subject: "https://5stack.test",
              },
      } as any,
      { add: trailing } as any,
      { getConnection: () => redis } as any,
    );
    await push.loadKeys();

    const notifications = new NotificationsService(
      hasura() as any,
      postgres,
      logger as any,
      { get: () => ({ webDomain: "https://5stack.test" }) } as any,
      new NotificationPreferencesService(postgres),
      push,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
    );
    notifyPlayers = jest.spyOn(notifications, "notifyPlayers");

    service = new NewsCommentsService(
      logger as any,
      postgres,
      { getConnection: () => redis } as any,
      notifications,
      new PlayerBlocksService(postgres),
    );
  });

  const HOSTILE =
    '<script>alert(1)</script><img src=x onerror="alert(2)"> ' +
    '<a href="javascript:alert(3)">x</a> javascript:alert(4)';

  const refused = (code: NewsCommentError) =>
    expect.objectContaining({ message: code });

  async function player(role = "verified_user", name?: string): Promise<User> {
    const steamId = await fx.player(name, role);
    return { steam_id: steamId, name: name ?? steamId, role: role as any };
  }

  async function article(
    publishedAgo: string | null = "1 day",
    status = "published",
    author: string | null = null,
  ): Promise<string> {
    seq += 1;
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO news_articles (slug, title, status, published_at, author_steam_id, content_markdown)
       VALUES ($1, $2, $3,
               CASE WHEN $4::text IS NULL THEN NULL ELSE now() - $4::interval END,
               $5::bigint, '')
       RETURNING id`,
      [`post-${seq}`, `Post <${seq}>`, status, publishedAgo, author],
    );
    return row.id;
  }

  const close = (articleId: string, ago = "8 days") =>
    postgres.query(
      `UPDATE news_articles SET published_at = now() - $2::interval WHERE id = $1`,
      [articleId, ago],
    );

  const post = async (
    user: User | undefined,
    articleId: string,
    body = "Nice post",
    parentId: string | null = null,
  ) =>
    (
      await service.post(user, {
        article_id: articleId,
        parent_id: parentId,
        body,
      })
    ).id;

  const insert = async (
    articleId: string,
    author: string,
    body = "Nice post",
    parentId: string | null = null,
  ) =>
    (
      await postgres.query<Array<{ id: string }>>(
        `INSERT INTO news_comments (article_id, parent_id, author_steam_id, body)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [articleId, parentId, author, body],
      )
    )[0].id;

  const row = async (id: string) =>
    (
      await postgres.query<
        Array<{
          parent_id: string | null;
          body: string;
          vote_count: number;
          edited: boolean;
          deleted: boolean;
          deleted_by_staff: boolean;
          hidden: boolean;
          hidden_by: string | null;
          hidden_reason: string | null;
        }>
      >(
        `SELECT parent_id, body, vote_count,
                edited_at IS NOT NULL AS edited,
                deleted_at IS NOT NULL AS deleted,
                deleted_by_staff,
                hidden_at IS NOT NULL AS hidden,
                hidden_by_steam_id::text AS hidden_by,
                hidden_reason
           FROM news_comments WHERE id = $1`,
        [id],
      )
    )[0];

  const age = async (id: string, interval: string) => {
    await postgres.query(
      "ALTER TABLE news_comments DISABLE TRIGGER tbu_news_comments",
    );
    await postgres.query(
      `UPDATE news_comments SET created_at = now() - $2::interval WHERE id = $1`,
      [id, interval],
    );
    await postgres.query(
      "ALTER TABLE news_comments ENABLE TRIGGER tbu_news_comments",
    );
  };

  const subscribe = (steamId: string) =>
    postgres.query(
      `INSERT INTO push_subscriptions (steam_id, endpoint, p256dh, auth)
       VALUES ($1::bigint, $2, 'key', 'auth')`,
      [steamId, `https://fcm.googleapis.com/fcm/send/${steamId}`],
    );

  // What Hasura's event trigger on notifications does for each new row.
  const pushNewest = async (steamId: string) => {
    const [newest] = await postgres.query<Array<{ id: string; type: string }>>(
      `SELECT id::text AS id, type::text AS type FROM notifications
        WHERE steam_id = $1::bigint ORDER BY created_at DESC LIMIT 1`,
      [steamId],
    );
    await push.sendForNotification(newest);
  };

  const pushes = () =>
    (webPush.sendNotification as jest.Mock).mock.calls.map(([, raw]) =>
      JSON.parse(raw),
    );

  const bell = async (steamId: string) =>
    (
      await postgres.query<Array<{ message: string }>>(
        `SELECT message FROM notifications
          WHERE steam_id = $1::bigint AND deleted_at IS NULL`,
        [steamId],
      )
    ).map(({ message }) => message);

  const titleOf = async (articleId: string) =>
    (
      await postgres.query<Array<{ title: string }>>(
        "SELECT title FROM news_articles WHERE id = $1",
        [articleId],
      )
    )[0].title;

  const sanction = (steamId: string, type: string, removeAt?: string) =>
    postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type, remove_sanction_date)
       VALUES ($1::bigint, $2, $3::timestamptz)`,
      [steamId, type, removeAt ?? null],
    );

  describe("who can write", () => {
    it("lets verified players and every role above them comment", async () => {
      const id = await article();

      for (const role of [
        "verified_user",
        "streamer",
        "moderator",
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ]) {
        await expect(post(await player(role), id)).resolves.toEqual(
          expect.any(String),
        );
      }
    });

    it("refuses guests and plain users, who still read", async () => {
      const id = await article();
      const author = await player();
      const comment = await post(author, id);
      const plain = await player("user");

      await expect(post(undefined, id)).rejects.toEqual(
        refused(NewsCommentError.SignIn),
      );
      await expect(post(plain, id)).rejects.toEqual(
        refused(NewsCommentError.NotVerified),
      );
      await expect(service.toggleVote(plain, { id: comment })).rejects.toEqual(
        refused(NewsCommentError.NotVerified),
      );
      await expect(
        service.toggleVote(undefined, { id: comment }),
      ).rejects.toEqual(refused(NewsCommentError.SignIn));
    });

    it("goes by the player's current role, not the one their session carries", async () => {
      const id = await article();
      const demoted = await player("user");

      await expect(
        post({ ...demoted, role: "verified_user" }, id),
      ).rejects.toEqual(refused(NewsCommentError.NotVerified));
    });

    it.each([
      ["ban", NewsCommentError.Banned],
      ["gag", NewsCommentError.Gagged],
      ["silence", NewsCommentError.Gagged],
    ])(
      "keeps a player under a %s from commenting, editing and +1ing",
      async (type, code) => {
        const id = await article();
        const sanctioned = await player();
        const own = await post(sanctioned, id);
        const other = await post(await player(), id);

        await sanction(sanctioned.steam_id, type);

        await expect(post(sanctioned, id)).rejects.toEqual(refused(code));
        await expect(
          service.edit(sanctioned, { id: own, body: "edited" }),
        ).rejects.toEqual(refused(code));
        await expect(
          service.toggleVote(sanctioned, { id: other }),
        ).rejects.toEqual(refused(code));
      },
    );

    it("lets a muted player comment, edit and +1, since a mute only covers voice", async () => {
      const id = await article();
      const muted = await player();
      const own = await post(muted, id);
      const other = await post(await player(), id);

      await sanction(muted.steam_id, "mute");

      await expect(post(muted, id, "still here")).resolves.toEqual(
        expect.any(String),
      );
      await expect(
        service.edit(muted, { id: own, body: "edited" }),
      ).resolves.toEqual({ id: own, parent_id: null });
      await expect(service.toggleVote(muted, { id: other })).resolves.toEqual(
        expect.objectContaining({ voted: true }),
      );
    });

    it("lets an expired or lifted sanction go", async () => {
      const id = await article();
      const expired = await player();
      const lifted = await player();

      await sanction(
        expired.steam_id,
        "gag",
        new Date(Date.now() - 60_000).toISOString(),
      );
      await sanction(lifted.steam_id, "ban");
      await postgres.query(
        "UPDATE player_sanctions SET deleted_at = now() WHERE player_steam_id = $1",
        [lifted.steam_id],
      );

      await expect(post(expired, id)).resolves.toEqual(expect.any(String));
      await expect(post(lifted, id)).resolves.toEqual(expect.any(String));
    });

    it("still lets a sanctioned player delete their own comment and take back a +1", async () => {
      const id = await article();
      const sanctioned = await player();
      const own = await post(sanctioned, id);
      const other = await post(await player(), id);
      await service.toggleVote(sanctioned, { id: other });

      await sanction(sanctioned.steam_id, "gag");

      await expect(
        service.toggleVote(sanctioned, { id: other }),
      ).resolves.toEqual({ comment_id: other, vote_count: 0, voted: false });
      await expect(service.remove(sanctioned, { id: own })).resolves.toEqual({
        success: true,
      });
      expect(await row(own)).toBeUndefined();
    });
  });

  describe("the 7-day window", () => {
    it("is open for 7 days after publishing, and never on a draft", async () => {
      const fresh = await article("6 days 23 hours");
      const old = await article("7 days 1 minute");
      const draft = await article(null, "draft");
      const pulled = await article("1 day", "draft");

      const [open] = await postgres.query<Array<Record<string, boolean>>>(
        `SELECT news_comments_open($1) AS fresh, news_comments_open($2) AS old,
                news_comments_open($3) AS draft, news_comments_open($4) AS pulled`,
        [fresh, old, draft, pulled],
      );

      expect(open).toEqual({
        fresh: true,
        old: false,
        draft: false,
        pulled: false,
      });
    });

    it("takes no new comments or replies once closed, and keeps what was said", async () => {
      const id = await article();
      const author = await player();
      const kept = await post(author, id);

      await close(id);

      await expect(post(author, id)).rejects.toEqual(
        refused(NewsCommentError.Closed),
      );
      await expect(post(await player(), id, "late", kept)).rejects.toEqual(
        refused(NewsCommentError.Closed),
      );
      await expect(insert(id, author.steam_id)).rejects.toThrow(
        NewsCommentError.Closed,
      );
      expect(await row(kept)).toEqual(
        expect.objectContaining({ body: "Nice post" }),
      );
    });

    it("closes +1s with the thread, adding and taking back alike", async () => {
      const id = await article();
      const author = await player();
      const voter = await player();
      const late = await player();
      const comment = await post(author, id);
      await service.toggleVote(voter, { id: comment });

      await close(id);

      await expect(service.toggleVote(voter, { id: comment })).rejects.toEqual(
        refused(NewsCommentError.Closed),
      );
      await expect(service.toggleVote(late, { id: comment })).rejects.toEqual(
        refused(NewsCommentError.Closed),
      );
      await expect(
        postgres.query(
          "DELETE FROM news_comment_votes WHERE comment_id = $1 AND steam_id = $2",
          [comment, voter.steam_id],
        ),
      ).rejects.toThrow(NewsCommentError.Closed);
      await expect(
        postgres.query(
          "INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)",
          [comment, late.steam_id],
        ),
      ).rejects.toThrow(NewsCommentError.Closed);
      expect((await row(comment)).vote_count).toBe(1);
    });

    it("still lets authors delete and staff hide or restore after it closes", async () => {
      const id = await article();
      const author = await player();
      const moderator = await player("moderator");
      const deleted = await post(author, id, "first");
      const hidden = await post(author, id, "second");

      await close(id, "30 days");

      await service.remove(author, { id: deleted });
      await service.setHidden(moderator, { id: hidden, hidden: true });
      expect((await row(hidden)).hidden).toBe(true);
      await service.setHidden(moderator, { id: hidden, hidden: false });

      expect(await row(deleted)).toBeUndefined();
      expect((await row(hidden)).hidden).toBe(false);
    });

    it("never takes comments on an unpublished post", async () => {
      const id = await article("1 hour", "draft");

      await expect(post(await player(), id)).rejects.toEqual(
        refused(NewsCommentError.NotFound),
      );
      await expect(insert(id, (await player()).steam_id)).rejects.toThrow(
        NewsCommentError.Closed,
      );
    });
  });

  describe("replies", () => {
    it("attaches a reply to a reply to the top-level comment", async () => {
      const id = await article();
      const a = await player();
      const b = await player();
      const c = await player();
      const top = await post(a, id);
      const reply = await post(b, id, "reply", top);

      const answer = await service.post(c, {
        article_id: id,
        parent_id: reply,
        body: "answer",
      });

      expect(answer.parent_id).toBe(top);
      expect((await row(answer.id)).parent_id).toBe(top);
      expect(
        (await row(await insert(id, a.steam_id, "x", reply))).parent_id,
      ).toBe(top);
    });

    it("refuses a reply across posts or under a removed comment", async () => {
      const id = await article();
      const other = await article();
      const a = await player();
      const b = await player();
      const moderator = await player("moderator");
      const top = await post(a, id);
      const hidden = await post(a, id, "hidden");
      const deleted = await post(a, id, "deleted");
      await post(b, id, "keeps it", deleted);

      await service.setHidden(moderator, { id: hidden, hidden: true });
      await service.remove(a, { id: deleted });

      await expect(post(b, other, "wrong post", top)).rejects.toEqual(
        refused(NewsCommentError.NotFound),
      );
      await expect(post(b, id, "late", hidden)).rejects.toEqual(
        refused(NewsCommentError.ParentRemoved),
      );
      await expect(post(b, id, "late", deleted)).rejects.toEqual(
        refused(NewsCommentError.ParentRemoved),
      );
      await expect(insert(id, b.steam_id, "late", hidden)).rejects.toThrow(
        NewsCommentError.ParentRemoved,
      );
    });
  });

  describe("editing and deleting", () => {
    it("edits your own comment for 10 minutes and marks it edited", async () => {
      const id = await article();
      const author = await player();
      const other = await player();
      const comment = await post(author, id, "typo");

      await expect(
        service.edit(author, { id: comment, body: "  fixed  " }),
      ).resolves.toEqual({ id: comment, parent_id: null });
      expect(await row(comment)).toEqual(
        expect.objectContaining({ body: "fixed", edited: true }),
      );

      await expect(
        service.edit(other, { id: comment, body: "mine now" }),
      ).rejects.toEqual(refused(NewsCommentError.NotYours));

      await age(comment, "11 minutes");

      await expect(
        service.edit(author, { id: comment, body: "late" }),
      ).rejects.toEqual(refused(NewsCommentError.EditWindow));
      await expect(
        postgres.query("UPDATE news_comments SET body = 'late' WHERE id = $1", [
          comment,
        ]),
      ).rejects.toThrow(NewsCommentError.EditWindow);
    });

    it("refuses an edit once the thread has closed, even inside the 10 minutes", async () => {
      const id = await article();
      const author = await player();
      const comment = await post(author, id, "typo");

      await close(id);

      await expect(
        service.edit(author, { id: comment, body: "fixed" }),
      ).rejects.toEqual(refused(NewsCommentError.Closed));
      await expect(
        postgres.query(
          "UPDATE news_comments SET body = 'fixed' WHERE id = $1",
          [comment],
        ),
      ).rejects.toThrow(NewsCommentError.Closed);
      expect((await row(comment)).body).toBe("typo");
    });

    it("keeps a reply that lands while its comment is being deleted", async () => {
      const id = await article();
      const author = await player();
      const replier = await player();
      const top = await post(author, id);

      const pool = (postgres as unknown as { pool: any }).pool;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO news_comments (article_id, parent_id, author_steam_id, body)
           VALUES ($1, $2, $3, 'just in time')`,
          [id, top, replier.steam_id],
        );

        const removal = service.remove(author, { id: top });

        for (let waited = 0; waited < 100; waited++) {
          const [{ waiting }] = await postgres.query<
            Array<{ waiting: number }>
          >(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          if (waiting > 0) {
            break;
          }
          await new Promise((settle) => setTimeout(settle, 50));
        }

        await client.query("COMMIT");
        await removal;
      } finally {
        client.release();
      }

      expect(await row(top)).toEqual(
        expect.objectContaining({ deleted: true }),
      );
      const [{ replies }] = await postgres.query<Array<{ replies: number }>>(
        "SELECT count(*)::int AS replies FROM news_comments WHERE parent_id = $1",
        [top],
      );
      expect(replies).toBe(1);
    });

    it("deletes a comment with no replies outright, and leaves a placeholder over one with replies", async () => {
      const id = await article();
      const author = await player();
      const replier = await player();
      const alone = await post(author, id, "alone");
      const answered = await post(author, id, "answered");
      const reply = await post(replier, id, "reply", answered);

      await service.remove(author, { id: alone });
      await service.remove(author, { id: answered });

      expect(await row(alone)).toBeUndefined();
      expect(await row(answered)).toEqual(
        expect.objectContaining({ deleted: true, deleted_by_staff: false }),
      );
      expect(await row(reply)).toEqual(
        expect.objectContaining({ body: "reply", deleted: false }),
      );
    });

    it("drops a deleted comment's placeholder once its last reply goes", async () => {
      const id = await article();
      const author = await player();
      const replier = await player();
      const top = await post(author, id);
      const first = await post(replier, id, "one", top);
      const second = await post(replier, id, "two", top);

      await service.remove(author, { id: top });
      await service.remove(replier, { id: first });
      expect((await row(top)).deleted).toBe(true);

      await service.remove(replier, { id: second });
      expect(await row(top)).toBeUndefined();
    });

    it("keeps a deleted comment deleted, and its text unchangeable", async () => {
      const id = await article();
      const author = await player();
      const top = await post(author, id);
      await post(await player(), id, "reply", top);
      await service.remove(author, { id: top });

      await expect(
        service.edit(author, { id: top, body: "back" }),
      ).rejects.toEqual(refused(NewsCommentError.Removed));
      await expect(
        postgres.query(
          "UPDATE news_comments SET deleted_at = NULL WHERE id = $1",
          [top],
        ),
      ).rejects.toThrow(NewsCommentError.Removed);
      await expect(
        postgres.query("UPDATE news_comments SET body = 'x' WHERE id = $1", [
          top,
        ]),
      ).rejects.toThrow(NewsCommentError.Removed);
    });

    it("never moves a comment to another post, thread or author", async () => {
      const id = await article();
      const other = await article();
      const author = await player();
      const comment = await post(author, id);

      await expect(
        postgres.query(
          "UPDATE news_comments SET article_id = $2 WHERE id = $1",
          [comment, other],
        ),
      ).rejects.toThrow(NewsCommentError.Immutable);
      await expect(
        postgres.query(
          "UPDATE news_comments SET author_steam_id = $2 WHERE id = $1",
          [comment, (await player()).steam_id],
        ),
      ).rejects.toThrow(NewsCommentError.Immutable);
    });
  });

  describe("+1", () => {
    it("is one per player, never on your own comment or a removed one, and keeps the count", async () => {
      const id = await article();
      const author = await player();
      const v1 = await player();
      const v2 = await player();
      const moderator = await player("moderator");
      const comment = await post(author, id);
      const hidden = await post(author, id, "rude");
      await service.setHidden(moderator, { id: hidden, hidden: true });

      await expect(service.toggleVote(v1, { id: comment })).resolves.toEqual({
        comment_id: comment,
        vote_count: 1,
        voted: true,
      });
      await expect(service.toggleVote(v2, { id: comment })).resolves.toEqual({
        comment_id: comment,
        vote_count: 2,
        voted: true,
      });
      await expect(service.toggleVote(v1, { id: comment })).resolves.toEqual({
        comment_id: comment,
        vote_count: 1,
        voted: false,
      });

      await expect(service.toggleVote(author, { id: comment })).rejects.toEqual(
        refused(NewsCommentError.OwnVote),
      );
      await expect(service.toggleVote(v1, { id: hidden })).rejects.toEqual(
        refused(NewsCommentError.Removed),
      );
      await expect(
        postgres.query(
          "INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)",
          [comment, author.steam_id],
        ),
      ).rejects.toThrow(NewsCommentError.OwnVote);
      await expect(
        postgres.query(
          "INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)",
          [comment, v2.steam_id],
        ),
      ).rejects.toThrow(/duplicate key/);
      expect((await row(comment)).vote_count).toBe(1);
    });

    it("lets a deleted post take its comments and +1s with it, even once closed", async () => {
      const id = await article();
      const author = await player();
      const voter = await player();
      const comment = await post(author, id);
      await post(voter, id, "reply", comment);
      await service.toggleVote(voter, { id: comment });

      await close(id, "30 days");
      await postgres.query("DELETE FROM news_articles WHERE id = $1", [id]);

      const [left] = await postgres.query<Array<Record<string, number>>>(
        `SELECT (SELECT count(*)::int FROM news_comments) AS comments,
                (SELECT count(*)::int FROM news_comment_votes) AS votes`,
      );
      expect(left).toEqual({ comments: 0, votes: 0 });
    });
  });

  describe("moderation", () => {
    it("lets moderators and above hide, restore and delete anyone's comment", async () => {
      const id = await article();
      const author = await player();

      for (const role of [
        "moderator",
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ]) {
        const staff = await player(role);
        const comment = await insert(id, author.steam_id, `rude ${role}`);
        const answered = await insert(id, author.steam_id, `answered ${role}`);
        await insert(id, (await player()).steam_id, "reply", answered);

        await service.setHidden(staff, {
          id: comment,
          hidden: true,
          reason: "  link spam  ",
        });
        expect(await row(comment)).toEqual(
          expect.objectContaining({
            hidden: true,
            hidden_by: staff.steam_id,
            hidden_reason: "link spam",
          }),
        );

        await service.setHidden(staff, { id: comment, hidden: false });
        expect(await row(comment)).toEqual(
          expect.objectContaining({
            hidden: false,
            hidden_by: null,
            hidden_reason: null,
          }),
        );

        await expect(service.remove(staff, { id: comment })).resolves.toEqual({
          success: true,
        });
        expect(await row(comment)).toBeUndefined();

        await service.remove(staff, { id: answered });
        expect(await row(answered)).toEqual(
          expect.objectContaining({ deleted: true, deleted_by_staff: true }),
        );
      }
    });

    it("refuses moderation from anyone below moderator, the post's author included", async () => {
      const postAuthor = await player();
      const id = await article("1 day", "published", postAuthor.steam_id);
      const comment = await post(await player(), id);

      for (const user of [
        postAuthor,
        await player("streamer"),
        await player("user"),
      ]) {
        await expect(
          service.setHidden(user, { id: comment, hidden: true }),
        ).rejects.toEqual(refused(NewsCommentError.StaffOnly));
        await expect(service.remove(user, { id: comment })).rejects.toEqual(
          refused(NewsCommentError.NotYours),
        );
      }
      await expect(
        service.setHidden(undefined, { id: comment, hidden: true }),
      ).rejects.toEqual(refused(NewsCommentError.SignIn));
      expect(await row(comment)).toEqual(
        expect.objectContaining({ hidden: false, deleted: false }),
      );
    });

    it("never lets staff edit someone else's words", async () => {
      const id = await article();
      const comment = await post(await player(), id);

      await expect(
        service.edit(await player("administrator"), {
          id: comment,
          body: "rewritten",
        }),
      ).rejects.toEqual(refused(NewsCommentError.NotYours));
    });
  });

  describe("untrusted text", () => {
    it("stores what was typed as plain text, without control characters or bidi overrides", async () => {
      const id = await article();
      const author = await player();

      const comment = await post(
        author,
        id,
        `  ${HOSTILE}\u0000\u0007\u202E\u2066 \r\nline two\t`,
      );

      expect((await row(comment)).body).toBe(`${HOSTILE} \nline two`);
      await expect(post(author, id, "\u0000\u202E\u0007 ")).rejects.toEqual(
        refused(NewsCommentError.Empty),
      );
      expect(
        (await row(await insert(id, author.steam_id, "a\u0007b\u202Ec"))).body,
      ).toBe("abc");
    });

    it("hands readers the same plain text back, markup and all, for the page to show as text", async () => {
      const id = await article();
      const comment = await post(await player(), id, HOSTILE);

      const [shown] = await postgres.query<Array<{ text: string }>>(
        `SELECT news_comment_text(c, '{"x-hasura-role":"guest"}'::json) AS text
           FROM news_comments c WHERE id = $1`,
        [comment],
      );
      expect(shown.text).toBe(HOSTILE);
    });

    it("keeps control characters out of a hide reason", async () => {
      const id = await article();
      const comment = await post(await player(), id);

      await service.setHidden(await player("moderator"), {
        id: comment,
        hidden: true,
        reason: "\u202Emaps\u0007 spam",
      });

      expect((await row(comment)).hidden_reason).toBe("maps spam");
    });
  });

  describe("limits", () => {
    it("gives every rate-limit window an expiry, and lets a player post again once it has passed", async () => {
      const id = await article();
      const author = await player();
      const voter = await player();
      const minute = `news-comments:post:minute:${author.steam_id}`;

      const comment = await post(author, id, "one");
      await service.edit(author, { id: comment, body: "one, edited" });
      await service.toggleVote(voter, { id: comment });

      const ttl = async (key: string) => await redis.pttl(key);
      for (const [key, window] of [
        [minute, 60_000],
        [`news-comments:post:day:${author.steam_id}`, 24 * 60 * 60_000],
        [`news-comments:edit:minute:${author.steam_id}`, 60_000],
        [`news-comments:vote:minute:${voter.steam_id}`, 60_000],
      ] as const) {
        expect(await ttl(key)).toBeGreaterThan(window - 10_000);
        expect(await ttl(key)).toBeLessThanOrEqual(window);
      }

      await post(author, id, "two");
      await post(author, id, "three");
      await expect(post(author, id, "four")).rejects.toEqual(
        refused(NewsCommentError.RateLimited),
      );

      await redis.pexpire(minute, 1);
      await new Promise((settle) => setTimeout(settle, 50));

      await expect(post(author, id, "four")).resolves.toEqual(
        expect.any(String),
      );
    });

    it("caps a comment at 2000 characters and refuses an empty one", async () => {
      const id = await article();
      const author = await player();

      await expect(post(author, id, "   \n ")).rejects.toEqual(
        refused(NewsCommentError.Empty),
      );
      await expect(post(author, id, "x".repeat(2001))).rejects.toEqual(
        refused(NewsCommentError.TooLong),
      );
      await expect(post(author, id, "x".repeat(2000))).resolves.toEqual(
        expect.any(String),
      );
      await expect(
        insert(id, author.steam_id, "x".repeat(2001)),
      ).rejects.toThrow(/news_comments_body_length/);
      await expect(insert(id, author.steam_id, "  ")).rejects.toThrow(
        /news_comments_body_length/,
      );
    });

    it("rate limits comments a minute and a day", async () => {
      const id = await article();
      const author = await player();
      const busy = await player();

      for (let i = 0; i < NewsCommentsService.POST_LIMIT_PER_MINUTE; i++) {
        await post(author, id, `comment ${i}`);
      }
      await expect(post(author, id)).rejects.toEqual(
        refused(NewsCommentError.RateLimited),
      );

      await redis.set(
        `news-comments:post:day:${busy.steam_id}`,
        NewsCommentsService.POST_LIMIT_PER_DAY,
      );
      await expect(post(busy, id)).rejects.toEqual(
        refused(NewsCommentError.DailyLimit),
      );
    });

    it("rate limits +1s", async () => {
      const id = await article();
      const comment = await post(await player(), id);
      const voter = await player();

      await redis.set(
        `news-comments:vote:minute:${voter.steam_id}`,
        NewsCommentsService.VOTE_LIMIT_PER_MINUTE,
      );

      await expect(service.toggleVote(voter, { id: comment })).rejects.toEqual(
        refused(NewsCommentError.RateLimited),
      );
    });
  });

  describe("what each reader is shown", () => {
    const session = (role: string, steamId = "0") =>
      JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId });

    const shown = async (role: string, steamId?: string) =>
      Object.fromEntries(
        (
          await postgres.query<Array<{ body: string; text: string | null }>>(
            `SELECT c.body, news_comment_text(c, $1::json) AS text
               FROM news_comments c
              WHERE news_comment_visible(c, $1::json)`,
            [session(role, steamId)],
          )
        ).map(({ body, text }) => [body, text]),
      );

    it("shows readers a removed comment only while replies hang off it, and never its text", async () => {
      const id = await article();
      const author = await player();
      const replier = await player();
      const moderator = await player("moderator");
      await insert(id, author.steam_id, "visible");
      const hidden = await insert(id, author.steam_id, "hidden alone");
      const hiddenAnswered = await insert(
        id,
        author.steam_id,
        "hidden answered",
      );
      const deletedAnswered = await insert(
        id,
        author.steam_id,
        "deleted answered",
      );
      await insert(id, replier.steam_id, "reply one", hiddenAnswered);
      await insert(id, replier.steam_id, "reply two", deletedAnswered);
      await service.setHidden(moderator, { id: hidden, hidden: true });
      await service.setHidden(moderator, { id: hiddenAnswered, hidden: true });
      await service.remove(author, { id: deletedAnswered });

      for (const role of ["guest", "user", "verified_user", "streamer"]) {
        expect(await shown(role, replier.steam_id)).toEqual({
          visible: "visible",
          "hidden answered": null,
          "deleted answered": null,
          "reply one": "reply one",
          "reply two": "reply two",
        });
      }

      for (const role of [
        "moderator",
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ]) {
        expect(await shown(role, moderator.steam_id)).toEqual({
          visible: "visible",
          "hidden alone": "hidden alone",
          "hidden answered": "hidden answered",
          "deleted answered": null,
          "reply one": "reply one",
          "reply two": "reply two",
        });
      }
    });

    it("drops a removed comment for readers once every reply under it is hidden too", async () => {
      const id = await article();
      const author = await player();
      const moderator = await player("moderator");
      const top = await post(author, id, "top");
      const reply = await post(await player(), id, "reply", top);
      await service.setHidden(moderator, { id: top, hidden: true });
      await service.setHidden(moderator, { id: reply, hidden: true });

      expect(await shown("user", author.steam_id)).toEqual({});
    });

    it("hides what the viewer blocked, never from staff and never the other way round", async () => {
      const id = await article();
      const blocker = await player();
      const blocked = await player();
      const moderator = await player("moderator");
      const theirs = await post(blocked, id, "blocked top");
      await post(blocker, id, "blocker top");
      await post(blocker, id, "blocker reply", theirs);

      await postgres.query(
        "INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id) VALUES ($1, $2), ($3, $2)",
        [blocker.steam_id, blocked.steam_id, moderator.steam_id],
      );

      expect(
        Object.keys(await shown("verified_user", blocker.steam_id)),
      ).toEqual(expect.not.arrayContaining(["blocked top"]));
      expect(
        Object.keys(await shown("verified_user", blocker.steam_id)),
      ).toEqual(expect.arrayContaining(["blocker top"]));
      expect(
        Object.keys(await shown("verified_user", blocked.steam_id)).sort(),
      ).toEqual(["blocked top", "blocker reply", "blocker top"]);
      expect(
        Object.keys(await shown("moderator", moderator.steam_id)).sort(),
      ).toEqual(["blocked top", "blocker reply", "blocker top"]);
      expect(Object.keys(await shown("guest")).sort()).toEqual([
        "blocked top",
        "blocker reply",
        "blocker top",
      ]);
    });

    it("shows nothing of a post that is not published", async () => {
      const id = await article();
      await post(await player(), id, "said while published");
      await postgres.query(
        "UPDATE news_articles SET status = 'draft' WHERE id = $1",
        [id],
      );

      expect(await shown("guest")).toEqual({});
      expect(await shown("administrator")).toEqual({});
    });

    it("tells a viewer which comments they +1'd, and a guest none", async () => {
      const id = await article();
      const voter = await player();
      const liked = await post(await player(), id, "liked");
      await post(await player(), id, "not liked");
      await service.toggleVote(voter, { id: liked });

      const voted = async (steamId: string) =>
        Object.fromEntries(
          (
            await postgres.query<Array<{ body: string; voted: boolean }>>(
              `SELECT c.body, news_comment_viewer_voted(c, $1::json) AS voted
                 FROM news_comments c`,
              [session("verified_user", steamId)],
            )
          ).map(({ body, voted }) => [body, voted]),
        );

      expect(await voted(voter.steam_id)).toEqual({
        liked: true,
        "not liked": false,
      });
      expect(await voted("0")).toEqual({ liked: false, "not liked": false });
    });

    it("never names the author of a removed comment to a reader, only to staff", async () => {
      const id = await article();
      const author = await player("verified_user", "marlowe");
      const moderator = await player("moderator");
      await insert(id, author.steam_id, "visible");
      const hidden = await insert(id, author.steam_id, "hidden");
      const deleted = await insert(id, author.steam_id, "deleted");
      await insert(id, moderator.steam_id, "reply one", hidden);
      await insert(id, moderator.steam_id, "reply two", deleted);
      await service.setHidden(moderator, { id: hidden, hidden: true });
      await service.remove(author, { id: deleted });

      const authors = async (role: string) =>
        Object.fromEntries(
          (
            await postgres.query<
              Array<{ body: string; author: string | null }>
            >(
              `SELECT c.body,
                      (SELECT a.name FROM news_comment_author(c, $1::json) a) AS author
                 FROM news_comments c
                WHERE c.parent_id IS NULL`,
              [session(role, moderator.steam_id)],
            )
          ).map(({ body, author }) => [body, author]),
        );

      for (const role of ["guest", "user", "verified_user", "streamer"]) {
        expect(await authors(role)).toEqual({
          visible: "marlowe",
          hidden: null,
          deleted: null,
        });
      }
      for (const role of ["moderator", "administrator"]) {
        expect(await authors(role)).toEqual({
          visible: "marlowe",
          hidden: "marlowe",
          deleted: null,
        });
      }
    });

    it("hides the replies under a comment the viewer blocked, so the count matches what is on the page", async () => {
      const id = await article();
      const viewer = await player();
      const blocked = await player();
      const other = await player();
      const theirs = await insert(id, blocked.steam_id, "blocked top");
      await insert(id, other.steam_id, "reply under it", theirs);
      const fine = await insert(id, other.steam_id, "fine top");
      await insert(id, blocked.steam_id, "blocked reply", fine);
      await insert(id, viewer.steam_id, "own reply", fine);

      await postgres.query(
        "INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id) VALUES ($1, $2)",
        [viewer.steam_id, blocked.steam_id],
      );

      expect(
        Object.keys(await shown("verified_user", viewer.steam_id)).sort(),
      ).toEqual(["fine top", "own reply"]);

      const [{ count }] = await postgres.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM news_comments c
          WHERE c.article_id = $1 AND c.deleted_at IS NULL AND c.hidden_at IS NULL
            AND news_comment_visible(c, $2::json)`,
        [id, session("verified_user", viewer.steam_id)],
      );
      expect(count).toBe(2);
      expect(
        Object.keys(await shown("moderator", viewer.steam_id)),
      ).toHaveLength(5);
    });

    it("serves a post's comments from a plain index on the post", async () => {
      const indexes = await postgres.query<
        Array<{ indexname: string; indexdef: string }>
      >(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'news_comments'",
      );

      expect(indexes.map(({ indexdef }) => indexdef)).toContainEqual(
        expect.stringMatching(
          /USING btree \(article_id, parent_id, created_at\)$/,
        ),
      );
      expect(indexes.map(({ indexname }) => indexname)).not.toContain(
        "news_comments_article_created_idx",
      );
    });

    it("names who hid a comment", async () => {
      const id = await article();
      const moderator = await player("moderator", "luke");
      const comment = await post(await player(), id);
      await service.setHidden(moderator, { id: comment, hidden: true });

      const [named] = await postgres.query<Array<{ name: string }>>(
        "SELECT news_comment_hidden_by_name(c) AS name FROM news_comments c WHERE id = $1",
        [comment],
      );
      expect(named.name).toBe("luke");
    });
  });

  describe("reply notifications", () => {
    it("notifies the player you replied to, with everything typed escaped", async () => {
      const id = await article();
      const [slug] = await postgres.query<Array<{ slug: string }>>(
        "SELECT slug FROM news_articles WHERE id = $1",
        [id],
      );
      const author = await player("verified_user", "marlowe");
      const replier = await player("verified_user", "<b>kairo</b>");
      const top = await post(author, id);
      const reply = await post(replier, id, "agreed <script>x</script>", top);

      expect(notifyPlayers).toHaveBeenCalledTimes(1);
      const [type, payload] = notifyPlayers.mock.calls[0];
      expect(type).toBe("NewsCommentReply");
      expect(payload).toEqual(
        expect.objectContaining({
          role: "user",
          entity_id: id,
          steamIds: [author.steam_id],
          title: "New reply to your comment",
          data: { messageId: reply, threadLabel: await titleOf(id) },
        }),
      );
      expect(payload.message).toContain("<b>&lt;b&gt;kairo&lt;/b&gt;</b>");
      expect(payload.message).toContain(
        `href="/news/${slug.slug}#comment-${reply}"`,
      );
      expect(payload.message).toContain("Post &lt;");
      expect(payload.message).toContain(
        "agreed &lt;script&gt;x&lt;/script&gt;",
      );
      expect(payload.message).not.toContain("<script>");
      expect(payload.message).not.toContain("<b>kairo");
    });

    it("keeps a hostile comment and a hostile name inert all the way to the bell, the push and its link", async () => {
      const id = await article();
      const [{ slug }] = await postgres.query<Array<{ slug: string }>>(
        "SELECT slug FROM news_articles WHERE id = $1",
        [id],
      );
      const author = await player();
      const replier = await player(
        "verified_user",
        '<img src=x onerror="alert(1)">',
      );
      const top = await post(author, id);
      const reply = await post(replier, id, HOSTILE, top);

      const [, payload] = notifyPlayers.mock.calls[0];
      const $ = load(payload.message);

      expect(payload.title).toBe("New reply to your comment");
      expect($("script, img, iframe, [onerror], [onclick]")).toHaveLength(0);
      expect(
        $("a")
          .map((_, a) => $(a).attr("href"))
          .get(),
      ).toEqual([`/news/${slug}#comment-${reply}`]);
      expect($.root().text()).toContain(HOSTILE);
      expect($.root().text()).toContain('<img src=x onerror="alert(1)">');
      expect(stripHtml(payload.message, 1000)).toContain(HOSTILE);
      expect(
        notificationUrl(
          {
            type: "NewsCommentReply",
            message: payload.message,
            entity_id: reply,
          },
          "https://5stack.test",
        ),
      ).toBe(`/news/${slug}#comment-${reply}`);
    });

    it("notifies the author of the reply you answered, not the thread's starter", async () => {
      const id = await article();
      const starter = await player();
      const replier = await player();
      const answerer = await player();
      const top = await post(starter, id);
      const reply = await post(replier, id, "reply", top);
      notifyPlayers.mockClear();

      await post(answerer, id, "answer", reply);

      expect(notifyPlayers).toHaveBeenCalledTimes(1);
      expect(notifyPlayers.mock.calls[0][1].steamIds).toEqual([
        replier.steam_id,
      ]);
    });

    it("never notifies for your own reply, a top-level comment, or the post's author", async () => {
      const postAuthor = await player();
      const id = await article("1 day", "published", postAuthor.steam_id);
      const author = await player();
      const top = await post(author, id);

      await post(author, id, "adding to my own comment", top);
      await post(await player(), id, "another top-level comment");

      expect(notifyPlayers).not.toHaveBeenCalled();
    });

    it("stays quiet when the player replied to has blocked the replier", async () => {
      const id = await article();
      const author = await player();
      const blocked = await player();
      const top = await post(author, id);
      await postgres.query(
        "INSERT INTO player_blocks (blocker_steam_id, blocked_steam_id) VALUES ($1, $2)",
        [author.steam_id, blocked.steam_id],
      );

      await expect(post(blocked, id, "still allowed", top)).resolves.toEqual(
        expect.any(String),
      );
      expect(notifyPlayers).not.toHaveBeenCalled();
    });

    it("bundles a burst of replies on one post into one push and a summary", async () => {
      const id = await article();
      const author = await player();
      await subscribe(author.steam_id);
      const top = await post(author, id, "Lower bracket?");

      for (const name of ["kairo", "ruu", "tjorn"]) {
        await post(
          await player("verified_user", name),
          id,
          `yes from ${name}`,
          top,
        );
        await pushNewest(author.steam_id);
      }

      expect(pushes()).toHaveLength(1);
      expect(pushes()[0]).toMatchObject({
        title: `New reply to your comment · ${await titleOf(id)}`,
        tag: `NewsCommentReply:${id}`,
      });
      expect(pushes()[0].body).toContain("yes from kairo");
      expect(trailing).toHaveBeenCalled();

      await push.sendPending(author.steam_id, `NewsCommentReply:${id}`);

      expect(pushes()).toHaveLength(2);
      expect(pushes()[1]).toMatchObject({
        tag: `NewsCommentReply:${id}`,
        body: "3 new replies",
      });
    });

    it("takes a reply's notification back from the bell and from a held push once the reply is hidden or deleted", async () => {
      const id = await article();
      const author = await player();
      const regretful = await player();
      await subscribe(author.steam_id);
      await postgres.query(
        `UPDATE players
            SET quiet_hours_start = (now() AT TIME ZONE 'UTC')::time - interval '1 hour',
                quiet_hours_end = (now() AT TIME ZONE 'UTC')::time + interval '1 hour',
                notification_timezone = 'UTC'
          WHERE steam_id = $1::bigint`,
        [author.steam_id],
      );
      const top = await post(author, id);
      const rude = await post(await player(), id, "rude reply", top);
      await pushNewest(author.steam_id);
      const regretted = await post(regretful, id, "regretted reply", top);
      await pushNewest(author.steam_id);
      const kept = await post(await player(), id, "kept reply", top);

      expect(pushes()).toEqual([]);
      expect(await bell(author.steam_id)).toHaveLength(3);

      await service.setHidden(await player("moderator"), {
        id: rude,
        hidden: true,
      });
      await service.remove(regretful, { id: regretted });

      const left = await bell(author.steam_id);
      expect(left).toHaveLength(1);
      expect(left[0]).toContain(`#comment-${kept}`);

      await postgres.query(
        `UPDATE players SET quiet_hours_start = NULL, quiet_hours_end = NULL
          WHERE steam_id = $1::bigint`,
        [author.steam_id],
      );
      await push.sendPending(author.steam_id, `NewsCommentReply:${id}`);

      expect(JSON.stringify(pushes())).not.toMatch(
        /rude reply|regretted reply/,
      );
    });

    it("keeps the reply when the notification fails", async () => {
      const id = await article();
      const top = await post(await player(), id);
      notifyPlayers.mockRejectedValueOnce(new Error("push down"));

      const reply = await post(await player(), id, "still saved", top);

      expect((await row(reply)).body).toBe("still saved");
    });
  });

  // Last: it drops the tables.
  describe("rollback", () => {
    it("down.sql removes the feature without touching news posts, and a re-deploy restores it", async () => {
      const dir = resolve(
        "hasura/migrations/default/1890000001020_news_comments",
      );
      const index = resolve(
        "hasura/migrations/default/1890000001030_news_comments_article_index",
      );
      await article();

      const objects = async () =>
        (
          await postgres.query<Array<Record<string, unknown>>>(
            `SELECT to_regclass('public.news_comments')::text AS comments,
                    to_regclass('public.news_comment_votes')::text AS votes,
                    to_regprocedure('public.news_comments_open(uuid)')::text AS open,
                    (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE '%news_comment%') AS triggers,
                    (SELECT count(*)::int FROM migration_hashes.hashes
                      WHERE replace(name, chr(92), '/') IN (
                        'hasura/functions/news/news_comments',
                        'hasura/triggers/news_comments'
                      )) AS digests,
                    (SELECT count(*)::int FROM pg_indexes
                      WHERE indexname = 'news_comments_article_parent_created_idx') AS indexed,
                    (SELECT count(*)::int FROM news_articles) AS articles`,
          )
        )[0];

      const installed = {
        comments: "news_comments",
        votes: "news_comment_votes",
        open: "news_comments_open(uuid)",
        triggers: 6,
        digests: 2,
        indexed: 1,
        articles: 1,
      };

      expect(await objects()).toEqual(installed);

      await postgres.query(
        `BEGIN;${readFileSync(join(index, "down.sql"), "utf8")};COMMIT;`,
      );
      await postgres.query(
        `BEGIN;${readFileSync(join(dir, "down.sql"), "utf8")};COMMIT;`,
      );
      expect(await objects()).toEqual({
        comments: null,
        votes: null,
        open: null,
        triggers: 0,
        digests: 0,
        indexed: 0,
        articles: 1,
      });

      await postgres.query(
        `BEGIN;${readFileSync(join(dir, "up.sql"), "utf8")};COMMIT;`,
      );
      await postgres.query(
        `BEGIN;${readFileSync(join(index, "up.sql"), "utf8")};COMMIT;`,
      );
      await db.hasura.apply(resolve("hasura/functions/news"));
      await db.hasura.apply(resolve("hasura/triggers/news_comments.sql"));
      expect(await objects()).toEqual(installed);
    });
  });
});
