import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// The gpu_vendor migration ships under a fork version, and its upstream copy
// is renamed to a new version, so a database that already has the column runs
// the same up.sql a second time. That run must change nothing, and a rollback
// followed by the up.sql again must leave the table as it was.
describe("gpu_vendor migration re-apply", () => {
  let db: SqlTestDb;

  const migration = join(
    __dirname,
    "../hasura/migrations/default/1889000001250_game_server_nodes_gpu_vendor",
  );
  const up = readFileSync(join(migration, "up.sql"), "utf8");
  const down = readFileSync(join(migration, "down.sql"), "utf8");

  const column = () =>
    db.postgres.query<
      Array<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'game_server_nodes'
          AND column_name = 'gpu_vendor'`,
    );

  const vendorChecks = () =>
    db.postgres.query<Array<{ definition: string }>>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'public.game_server_nodes'::regclass
          AND conname = 'game_server_nodes_gpu_vendor_check'`,
    );

  // Every column and constraint of the table by name, to compare the table
  // before a rollback with the table after the up.sql runs again.
  const tableShape = async () => ({
    columns: await db.postgres.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'game_server_nodes'
        ORDER BY column_name`,
    ),
    constraints: await db.postgres.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'public.game_server_nodes'::regclass
        ORDER BY conname`,
    ),
  });

  beforeAll(async () => {
    db = await bootMigratedDb("GpuVendorMigrationTest");
    await db.postgres.query(
      `INSERT INTO server_regions (value, description) VALUES ('GpuRegion', 'GpuRegion')
       ON CONFLICT (value) DO NOTHING`,
    );
    await db.postgres.query(
      `INSERT INTO game_server_nodes (id, region, status, enabled, label, gpu, gpu_vendor)
       VALUES ('amd-node', 'GpuRegion', 'Online', true, 'amd-node', true, 'amd')`,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("applies cleanly a second time and changes nothing", async () => {
    await expect(db.postgres.query(up)).resolves.toBeDefined();

    expect(await column()).toEqual([
      { data_type: "text", is_nullable: "YES", column_default: null },
    ]);
    expect(await vendorChecks()).toEqual([
      {
        definition:
          "CHECK ((gpu_vendor = ANY (ARRAY['nvidia'::text, 'amd'::text])))",
      },
    ]);

    const [row] = await db.postgres.query<Array<{ gpu_vendor: string }>>(
      "SELECT gpu_vendor FROM game_server_nodes WHERE id = 'amd-node'",
    );
    expect(row.gpu_vendor).toBe("amd");
  });

  it("rolls back and migrates again to the same table", async () => {
    const before = await tableShape();

    await db.postgres.query(down);
    expect(await column()).toEqual([]);
    expect(await vendorChecks()).toEqual([]);

    await db.postgres.query(up);
    expect(await tableShape()).toEqual(before);
  });
});
