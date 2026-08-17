import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The chat/notification migration shipped once, gained columns and a
// notification type, and had its version bumped each time so stacks that
// already applied an earlier cut would re-run it.
// A bumped migration only helps if it is genuinely idempotent *and* reconciles
// the older shape -- CREATE TABLE IF NOT EXISTS silently skips a table that is
// already there, which is how a live stack ended up without direct_messages.seq
// and failed every attempt to open a conversation.
//
// This rewinds a migrated database to that older shape and re-applies the file.
describe("chat migration re-apply", () => {
  let db: SqlTestDb;

  const up = readFileSync(
    join(
      __dirname,
      "../hasura/migrations/default/1877000006000_chat_and_notification_delivery/up.sql",
    ),
    "utf8",
  );

  beforeAll(async () => {
    db = await bootMigratedDb("ChatMigrationTest");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const columns = async (table: string) =>
    (
      await db.postgres.query<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      )
    ).map(({ column_name }) => column_name);

  const indexDefinition = async (name: string) =>
    (
      await db.postgres.query<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = $1`,
        [name],
      )
    ).at(0)?.indexdef;

  beforeAll(async () => {
    // Rewind to the shape the first cut left behind.
    await db.postgres.query(`
      ALTER TABLE public.direct_messages DROP COLUMN IF EXISTS seq;
      DROP INDEX IF EXISTS public.direct_messages_room_id_created_at_idx;
      CREATE INDEX direct_messages_room_id_created_at_idx
        ON public.direct_messages (room_id, created_at DESC);

      ALTER TABLE public.direct_conversations
        DROP COLUMN IF EXISTS is_open,
        DROP COLUMN IF EXISTS position;

      DROP TABLE IF EXISTS public.chat_read_state;
      CREATE TABLE public.chat_read_state (
        steam_id bigint NOT NULL REFERENCES public.players(steam_id)
          ON UPDATE cascade ON DELETE cascade,
        thread_type text NOT NULL,
        thread_id text NOT NULL,
        last_read_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (steam_id, thread_type, thread_id)
      );
    `);

    await db.postgres.query(
      `INSERT INTO public.players (steam_id, name) VALUES (76561199500000001, 'Rewound')
       ON CONFLICT (steam_id) DO NOTHING`,
    );

    await db.postgres.query(
      `INSERT INTO public.chat_read_state (steam_id, thread_type, thread_id)
            VALUES (76561199500000001, 'match', 'm-1')`,
    );

    await db.postgres.query(up);
  }, 600_000);

  it("adds the tie-break column the older shape is missing", async () => {
    expect(await columns("direct_messages")).toContain("seq");
  });

  it("rebuilds the index so the tie-break has one to use", async () => {
    // CREATE INDEX IF NOT EXISTS would have found the old one by name and done
    // nothing, leaving created_at ordering non-deterministic.
    expect(await indexDefinition("direct_messages_room_id_created_at_idx")).toContain(
      "seq",
    );
  });

  it("carries read cursors onto the single-column thread key", async () => {
    expect(await columns("chat_read_state")).toEqual(
      expect.arrayContaining(["thread"]),
    );
    expect(await columns("chat_read_state")).not.toContain("thread_type");

    const [row] = await db.postgres.query<Array<{ thread: string }>>(
      `SELECT thread FROM public.chat_read_state WHERE steam_id = 76561199500000001`,
    );

    // Losing these would make every thread on the platform look unread at once.
    expect(row.thread).toBe("chat:match:m-1");
  });

  it("keys the rebuilt cursor table on the thread", async () => {
    const [row] = await db.postgres.query<Array<{ definition: string }>>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'public.chat_read_state'::regclass AND contype = 'p'`,
    );

    expect(row.definition).toBe("PRIMARY KEY (steam_id, thread)");
  });

  it("adds the rail columns", async () => {
    expect(await columns("direct_conversations")).toEqual(
      expect.arrayContaining(["is_open", "position"]),
    );
  });

  // Splitting match chat off ChatMessage strands every row already written
  // under the old type: markThreadRead clears a match thread by looking for
  // MatchChatMessage, so anything left behind sits unread in the bell forever.
  describe("match chat backfill", () => {
    const typeOf = async (entityId: string) =>
      (
        await db.postgres.query<Array<{ type: string }>>(
          `SELECT type FROM public.notifications WHERE entity_id = $1`,
          [entityId],
        )
      ).at(0)?.type;

    beforeAll(async () => {
      await db.postgres.query(
        `INSERT INTO public.players (steam_id, name)
              VALUES (76561199500000002, 'Backfilled')
         ON CONFLICT (steam_id) DO NOTHING`,
      );

      for (const entity of ["match:m-9", "match_team:m-9:l-1", "direct:1:2"]) {
        await db.postgres.query(
          `INSERT INTO public.notifications
                  (type, title, message, role, steam_id, entity_id)
                VALUES ('ChatMessage', 'Luke', 'hey', 'user', 76561199500000002, $1)`,
          [entity],
        );
      }

      // The backfill is part of the same migration, so this re-applies it over
      // rows written since -- which the file is built to survive.
      await db.postgres.query(up);
    }, 600_000);

    it("moves a match room's rows to the new type", async () => {
      expect(await typeOf("match:m-9")).toBe("MatchChatMessage");
    });

    it("leaves team chat alone", async () => {
      // `match_team:` starts with `match`, so a `LIKE 'match%'` would have
      // taken this too.
      expect(await typeOf("match_team:m-9:l-1")).toBe("ChatMessage");
    });

    it("leaves conversations alone", async () => {
      expect(await typeOf("direct:1:2")).toBe("ChatMessage");
    });
  });

  it("applies cleanly a second time", async () => {
    await expect(db.postgres.query(up)).resolves.toBeDefined();

    expect(await columns("direct_messages")).toContain("seq");
    expect(await indexDefinition("direct_messages_room_id_created_at_idx")).toContain(
      "seq",
    );
  });
});
