import { PostgresService } from "./../src/postgres/postgres.service";
import { HasuraService } from "./../src/hasura/hasura.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Only hasura's init container runs setup(). An api that came up on a newer
// build has to see from the database alone that its schema never ran.
describe("HasuraService.needsSetup (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let hasura: HasuraService;
  const originalRunMigrations = process.env.RUN_MIGRATIONS;

  beforeAll(async () => {
    db = await bootMigratedDb("HasuraNeedsSetupTest");
    postgres = db.postgres;
    hasura = db.hasura;

    // As hasura's init container runs it.
    process.env.RUN_MIGRATIONS = "true";
    try {
      await hasura.setup();
    } finally {
      if (originalRunMigrations === undefined) {
        delete process.env.RUN_MIGRATIONS;
      } else {
        process.env.RUN_MIGRATIONS = originalRunMigrations;
      }
    }
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const forgetHash = async (name: string) => {
    const [row] = await postgres.query<Array<{ hash: string }>>(
      "DELETE FROM migration_hashes.hashes WHERE name = $1 RETURNING hash",
      [name],
    );
    expect(row?.hash).toBeDefined();

    return () =>
      postgres.query(
        "INSERT INTO migration_hashes.hashes (name, hash) VALUES ($1, $2)",
        [name, row.hash],
      );
  };

  it("is satisfied once setup has run this build", async () => {
    expect(await hasura.needsSetup()).toBe(false);
  });

  // A dev api runs setup() itself, but hasura only loads metadata when its own
  // pod starts.
  it("does not count a dev api's setup as hasura loading metadata", async () => {
    const restore = await forgetHash("hasura/metadata");

    try {
      await hasura.setup();
      expect(await hasura.needsSetup()).toBe(true);
    } finally {
      await restore();
    }
  });

  it("sees a migration that never ran", async () => {
    const [row] = await postgres.query<Array<{ version: string }>>(
      `DELETE FROM hdb_catalog.schema_migrations
        WHERE version = (SELECT max(version) FROM hdb_catalog.schema_migrations)
        RETURNING version`,
    );

    try {
      expect(await hasura.needsSetup()).toBe(true);
    } finally {
      await postgres.query(
        "INSERT INTO hdb_catalog.schema_migrations (version, dirty) VALUES ($1, false)",
        [row.version],
      );
    }
  });

  it.each(["enums", "functions", "views", "triggers"])(
    "sees a file in hasura/%s it has not applied",
    async (dir) => {
      const [{ name }] = await postgres.query<Array<{ name: string }>>(
        `SELECT min(name) AS name FROM migration_hashes.hashes
          WHERE starts_with(name, $1)`,
        [`hasura/${dir}/`],
      );
      const restore = await forgetHash(name);

      try {
        expect(await hasura.needsSetup()).toBe(true);
      } finally {
        await restore();
      }
    },
  );

  // Hasura loads metadata from the init container's copy of the image, so a
  // release that only adds an action still needs hasura replaced.
  it("sees metadata hasura never loaded", async () => {
    const restore = await forgetHash("hasura/metadata");

    try {
      expect(await hasura.needsSetup()).toBe(true);
    } finally {
      await restore();
    }
  });
});
