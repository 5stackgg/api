import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Chat pushes straight from the conversation now, so the rows it used to write
// would only sit in the bell, and an in-app chat preference has no toggle left
// to change it back.
describe("drop chat notifications migration", () => {
  let db: SqlTestDb;

  const up = readFileSync(
    join(
      __dirname,
      "../hasura/migrations/default/1889000001600_drop_chat_notifications/up.sql",
    ),
    "utf8",
  );

  const STEAM_ID = "76561199500000021";

  const typesLeft = async () =>
    (
      await db.postgres.query<Array<{ type: string }>>(
        `SELECT type FROM public.notifications
          WHERE steam_id = $1
          ORDER BY type`,
        [STEAM_ID],
      )
    ).map(({ type }) => type);

  const preferenceKeys = async () =>
    (
      await db.postgres.query<Array<{ channel: string; key: string }>>(
        `SELECT channel, key FROM public.notification_preferences
          WHERE steam_id = $1
          ORDER BY channel, key`,
        [STEAM_ID],
      )
    ).map(({ channel, key }) => `${channel}:${key}`);

  beforeAll(async () => {
    db = await bootMigratedDb("DropChatNotificationsTest");

    await db.postgres.query(
      `INSERT INTO public.players (steam_id, name) VALUES ($1, 'Chatty')
       ON CONFLICT (steam_id) DO NOTHING`,
      [STEAM_ID],
    );

    for (const type of ["ChatMessage", "MatchChatMessage", "MatchImported"]) {
      await db.postgres.query(
        `INSERT INTO public.notifications
                (type, title, message, role, steam_id, entity_id)
              VALUES ($2, 'DrClampz', 'gg', 'user', $1, 'direct:1:2')`,
        [STEAM_ID, type],
      );
    }

    for (const [channel, key] of [
      ["in_app", "ChatMessage"],
      ["in_app", "MatchChatMessage"],
      ["in_app", "MatchImported"],
      ["push", "chat"],
    ]) {
      await db.postgres.query(
        `INSERT INTO public.notification_preferences
                (steam_id, channel, key, enabled)
              VALUES ($1, $2, $3, false)`,
        [STEAM_ID, channel, key],
      );
    }

    await db.postgres.query(up);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("deletes the chat rows and nothing else", async () => {
    expect(await typesLeft()).toEqual(["MatchImported"]);
  });

  it("drops the index that only found chat rows", async () => {
    const [{ count }] = await db.postgres.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM pg_indexes
        WHERE indexname = 'notifications_message_id_idx'`,
    );

    expect(count).toBe("0");
  });

  it("drops only the in-app chat preferences", async () => {
    expect(await preferenceKeys()).toEqual([
      "in_app:MatchImported",
      "push:chat",
    ]);
  });
});
