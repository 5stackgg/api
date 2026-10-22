import { Client } from "pg";
import { bootMigratedDb } from "./utils/sql-test-db";

describe("SQL clone cleanup", () => {
  it("defers dropping a clone while another connection still uses it", async () => {
    const db = await bootMigratedDb("CloneCleanup");
    const [{ database }] = await db.postgres.query<Array<{ database: string }>>(
      "SELECT current_database() AS database",
    );
    const connection = {
      host: process.env.SQL_TEST_HOST!,
      port: Number(process.env.SQL_TEST_PORT),
      user: process.env.SQL_TEST_USER!,
      password: process.env.SQL_TEST_PASSWORD!,
    };
    const other = new Client({ ...connection, database });
    const errors: Error[] = [];
    other.on("error", (error) => errors.push(error));
    let stopped = false;
    try {
      await other.connect();
      await db.stop();
      stopped = true;
      expect(db.postgres.getPoolStats().totalCount).toBe(0);
      expect((await other.query("SELECT 1 AS value")).rows).toEqual([{ value: 1 }]);
      expect(errors).toEqual([]);
    } finally {
      await other.end();
      if (!stopped) await db.stop();
      const admin = new Client({ ...connection, database: "postgres" });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      } finally {
        await admin.end();
      }
    }
  }, 600_000);
});
