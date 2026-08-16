import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import { UseQueue } from "../../utilities/QueueProcessors";
import { ChatQueues } from "../enums/ChatQueues";
import { PostgresService } from "../../postgres/postgres.service";
import { RedisManagerService } from "../../redis/redis-manager/redis-manager.service";
import { ChatLobbyType } from "../enums/ChatLobbyTypes";
import { parseDirectRoomId } from "../utilities/directRoomId";

// Carries the DMs that were in redis when this shipped over into postgres.
//
// Without it a deploy silently empties every conversation on the platform: the
// join handler reads DMs from postgres now, and the redis hashes it used to
// read would sit there until their TTL ran out with nothing looking at them.
//
// Runs once, marked by a settings row. Idempotent regardless -- inserts are
// ON CONFLICT DO NOTHING on the message id, which is the same uuid the redis
// payload carried.
const DONE_SETTING = "chat_direct_backfilled";

@UseQueue("Chat", ChatQueues.ChatMaintenance)
export class BackfillDirectMessages extends WorkerHost {
  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    redisManager: RedisManagerService,
  ) {
    super();
    this.redis = redisManager.getConnection();
  }

  async process(_job: Job): Promise<void> {
    const [done] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [DONE_SETTING],
    );

    if (done) {
      return;
    }

    const prefix = `chat_${ChatLobbyType.Direct}_`;
    let cursor = "0";
    let migrated = 0;

    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        200,
      );
      cursor = next;

      for (const key of keys) {
        migrated += await this.migrateRoom(key.slice(prefix.length), key);
      }
    } while (cursor !== "0");

    await this.postgres.query(
      `INSERT INTO public.settings (name, value) VALUES ($1, 'true')
       ON CONFLICT (name) DO NOTHING`,
      [DONE_SETTING],
    );

    this.logger.log(`backfilled ${migrated} direct message(s) into postgres`);
  }

  private async migrateRoom(roomId: string, key: string): Promise<number> {
    const parties = parseDirectRoomId(roomId);

    if (!parties) {
      return 0;
    }

    const stored = await this.redis.hgetall(key);
    let migrated = 0;
    let lastMessageAt: string | undefined;

    for (const raw of Object.values(stored)) {
      let message: {
        id?: string;
        message?: string;
        timestamp?: string;
        from?: { steam_id?: string };
      };

      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }

      if (!message?.id || !message.message || !message.from?.steam_id) {
        continue;
      }

      // The sender may have been a shadow row that has since been deleted, and
      // a whole room's history is not worth losing to one orphan.
      try {
        await this.postgres.query(
          `INSERT INTO public.direct_messages (id, room_id, from_steam_id, message, created_at)
                VALUES ($1::uuid, $2, $3::bigint, $4, $5::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [
            message.id,
            roomId,
            message.from.steam_id,
            message.message,
            message.timestamp,
          ],
        );
      } catch (error) {
        this.logger.warn(
          `unable to backfill direct message ${message.id}`,
          error,
        );
        continue;
      }

      migrated++;

      if (!lastMessageAt || message.timestamp > lastMessageAt) {
        lastMessageAt = message.timestamp;
      }
    }

    if (!lastMessageAt) {
      return migrated;
    }

    await this.postgres.query(
      `INSERT INTO public.direct_conversations (room_id, steam_id, last_message_at)
            SELECT $1, steam_id, $3::timestamptz
              FROM unnest($2::bigint[]) AS steam_id
             WHERE EXISTS (
               SELECT 1 FROM public.players p WHERE p.steam_id = steam_id
             )
       ON CONFLICT (room_id, steam_id) DO UPDATE
               SET last_message_at = GREATEST(
                     public.direct_conversations.last_message_at,
                     EXCLUDED.last_message_at)`,
      [roomId, parties, lastMessageAt],
    );

    return migrated;
  }
}
