import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Team rooms moved from ChatMessage to MatchChatMessage. The read-clear and the
// bell collapse look rows up by the new type, so any team row left on the old
// one would sit unread in the bell forever.
describe("match team chat notification type migration", () => {
  let db: SqlTestDb;

  const migration = join(
    __dirname,
    "../hasura/migrations/default/1888000000400_match_team_chat_notification_type",
  );
  const up = readFileSync(join(migration, "up.sql"), "utf8");
  const down = readFileSync(join(migration, "down.sql"), "utf8");

  const STEAM_ID = "76561199500000011";

  const typeOf = async (entityId: string) =>
    (
      await db.postgres.query<Array<{ type: string }>>(
        `SELECT type FROM public.notifications WHERE entity_id = $1`,
        [entityId],
      )
    ).at(0)?.type;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchTeamChatNotificationTypeTest");

    await db.postgres.query(
      `INSERT INTO public.players (steam_id, name) VALUES ($1, 'Retyped')
       ON CONFLICT (steam_id) DO NOTHING`,
      [STEAM_ID],
    );

    for (const entity of [
      "match_team:m-9:l-1",
      "match:m-9",
      "direct:1:2",
      "matchXteam:m-9:l-1",
    ]) {
      await db.postgres.query(
        `INSERT INTO public.notifications
                (type, title, message, role, steam_id, entity_id)
              VALUES ('ChatMessage', 'Luke', 'hey', 'user', $1, $2)`,
        [STEAM_ID, entity],
      );
    }

    await db.postgres.query(up);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("moves a team room's rows to match chat", async () => {
    expect(await typeOf("match_team:m-9:l-1")).toBe("MatchChatMessage");
  });

  it("leaves rows that are not team rooms alone", async () => {
    expect(await typeOf("match:m-9")).toBe("ChatMessage");
    expect(await typeOf("direct:1:2")).toBe("ChatMessage");
  });

  it("does not treat the underscore as a wildcard", async () => {
    expect(await typeOf("matchXteam:m-9:l-1")).toBe("ChatMessage");
  });

  it("puts only the team rows back on the way down", async () => {
    await db.postgres.query(
      `UPDATE public.notifications SET type = 'MatchChatMessage'
        WHERE entity_id = 'match:m-9'`,
    );

    await db.postgres.query(down);

    expect(await typeOf("match_team:m-9:l-1")).toBe("ChatMessage");
    expect(await typeOf("match:m-9")).toBe("MatchChatMessage");

    await db.postgres.query(up);
  });
});
