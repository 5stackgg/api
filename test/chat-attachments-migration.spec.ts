import { readFileSync } from "fs";
import { join, resolve } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

const MIGRATIONS = resolve(__dirname, "../hasura/migrations/default");

// 1890000000200 shipped before the deletion evidence and the upload ledger
// existed, and a stack that ran it will never run it again. Whatever came
// after has to arrive under a version of its own.
describe("chat attachments migrations", () => {
  let db: SqlTestDb;

  beforeAll(async () => {
    db = await bootMigratedDb("ChatAttachmentsMigrationTest");
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

  it("leaves the migration that shipped as it shipped", () => {
    const shipped = readFileSync(
      join(MIGRATIONS, "1890000000200_chat_attachments/up.sql"),
      "utf8",
    );

    expect(shipped).not.toMatch(/chat_attachment_usage|deleted_at/);
  });

  it("brings a stack that ran only the shipped migration up to date", async () => {
    await db.postgres.query(`
      DROP TABLE IF EXISTS public.chat_attachment_usage;
      ALTER TABLE public.chat_attachments DROP COLUMN IF EXISTS deleted_at;
      ALTER TABLE public.chat_message_deletions
          DROP COLUMN IF EXISTS attachments,
          DROP COLUMN IF EXISTS gif;
      DELETE FROM hdb_catalog.schema_migrations
       WHERE version > 1890000000200 AND version < 1890000000300;
    `);

    await (db.hasura as any).applyMigrations(MIGRATIONS);

    expect(await columns("chat_attachments")).toContain("deleted_at");
    expect(await columns("chat_attachment_usage")).toEqual(
      expect.arrayContaining(["steam_id", "bytes", "created_at"]),
    );
    expect(await columns("chat_message_deletions")).toEqual(
      expect.arrayContaining(["attachments", "gif"]),
    );
  });

  it("runs the follow-up again without complaint", async () => {
    await db.postgres.query(`
      DELETE FROM hdb_catalog.schema_migrations
       WHERE version > 1890000000200 AND version < 1890000000300;
    `);

    await expect(
      (db.hasura as any).applyMigrations(MIGRATIONS),
    ).resolves.toEqual(expect.any(Number));
  });
});
