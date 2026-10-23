import { PostgresService } from "../src/postgres/postgres.service";
import { HasuraPermissions } from "./utils/hasura-permissions";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

describe("steam account permissions", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("SteamAccountPermissionsTest");
    postgres = db.postgres;
    await postgres.query(
      `INSERT INTO steam_accounts (username, password, role)
       VALUES ('gpu_pool', 'pw', 'gpu'), ('presence_bot', 'pw', 'friends')`,
    );
  });

  afterAll(async () => {
    await db?.stop();
  });

  async function reachable(operation: "select" | "update" | "delete") {
    const params: Array<unknown> = [];
    const where = await new HasuraPermissions(postgres).where(
      "steam_accounts",
      operation,
      "t",
      { role: "administrator", userId: "76561198000000001" },
      params,
    );
    const rows = await postgres.query<Array<{ username: string }>>(
      `SELECT t.username FROM public.steam_accounts t WHERE ${where} ORDER BY 1`,
      params as Array<string>,
    );
    return rows.map((row) => row.username);
  }

  it.each(["select", "update", "delete"] as const)(
    "leaves the presence bot out of the GPU pool for an admin %s",
    async (operation) => {
      expect(await reachable(operation)).toEqual(["gpu_pool"]);
    },
  );
});
