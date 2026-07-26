import { createHash, randomBytes } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client } from "pg";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { HasuraService } from "../../src/hasura/hasura.service";
import { PostgresService } from "../../src/postgres/postgres.service";

// Image, extensions, and connection user mirror production
// (5stack-panel/base/timescaledb): create_hypertable migrations need
// TimescaleDB, and setup() calls pg_stat_statements_reset() after migrating,
// which requires pg_stat_statements in shared_preload_libraries.
const IMAGE = "timescale/timescaledb:latest-pg17";
const TEMPLATE_DB = "hasura";

// Serializes CREATE DATABASE ... TEMPLATE across parallel jest workers; the
// template must have no concurrent access while it's being copied.
const CLONE_LOCK_ID = 421337;

// Where the fingerprint of the migrated template is kept. It lives in the
// maintenance database so it survives dropping and rebuilding the template.
const FINGERPRINT_TABLE = "public._sql_test_template";

type Connection = {
  host: string;
  port: number;
  user: string;
  password: string;
};

function connectionFromEnv(): Connection {
  return {
    host: process.env.SQL_TEST_HOST!,
    port: Number(process.env.SQL_TEST_PORT),
    user: process.env.SQL_TEST_USER!,
    password: process.env.SQL_TEST_PASSWORD!,
  };
}

async function withAdmin<T>(
  connection: Connection,
  fn: (admin: Client) => Promise<T>,
): Promise<T> {
  // CREATE/DROP DATABASE cannot run inside a pool or a transaction; they need a
  // raw client on the maintenance database.
  const admin = new Client({ ...connection, database: "postgres" });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

// Digest of every migration file. Migrations in this repo get edited in place
// (squashed, renumbered), and an already-recorded version never re-runs, so a
// reused template cannot be patched forward — any change means rebuild. Boot
// phases are deliberately excluded: setup() hashes those files itself and
// re-applies just the ones that changed, which costs nothing.
function migrationsFingerprint(): string {
  const root = join(process.cwd(), "hasura", "migrations");
  const digest = createHash("sha1");

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      digest.update(path.slice(root.length));
      digest.update(readFileSync(path));
    }
  };

  walk(root);
  return digest.digest("hex");
}

export interface SqlTestDb {
  container?: StartedPostgreSqlContainer;
  postgres: PostgresService;
  hasura: HasuraService;
  stop(): Promise<void>;
}

function makeServices(
  connection: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  },
  loggerName: string,
): { postgres: PostgresService; hasura: HasuraService } {
  const configService = new ConfigService({
    postgres: { connections: { default: { ...connection, max: 5 } } },
    app: { demosDomain: "demos.test", relayDomain: "relay.test" },
  });

  const logger = new Logger(loggerName);
  const postgres = new PostgresService(configService, logger);
  const hasura = new HasuraService(
    logger,
    // CacheService is unused by setup(); the GraphQL/cache paths are not exercised.
    null as never,
    configService,
    postgres,
  );

  return { postgres, hasura };
}

export async function endPool(postgres: PostgresService): Promise<void> {
  // Drain the pool before its database goes away, otherwise pg emits an
  // idle-client error when the socket is torn out from under it.
  await (
    postgres as unknown as { pool: { end(): Promise<void> } }
  )?.pool?.end();
}

// Boots a throwaway Postgres and drives the real HasuraService.setup() through
// the full migration -> enums -> functions -> views -> triggers pipeline, so
// trigger/function behavior under test matches a fresh install exactly.
//
// `reuse` keeps the container alive between `yarn test:sql` runs and skips the
// migration pipeline when nothing under hasura/migrations changed, which is the
// difference between paying the boot cost once and paying it every invocation.
export async function bootContainerAndMigrate(
  loggerName: string,
  { reuse = false }: { reuse?: boolean } = {},
): Promise<SqlTestDb> {
  const builder = new PostgreSqlContainer(IMAGE)
    .withDatabase(TEMPLATE_DB)
    .withUsername("hasura")
    .withPassword("hasura")
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=timescaledb,pg_stat_statements",
      // The servers trigger encrypts rcon passwords with pgp_sym_encrypt_bytea
      // keyed by this GUC; prod provisions it on the database, tests set it at
      // server start so seeding servers works.
      "-c",
      "fivestack.app_key=test-app-key",
      // Parallel suites each hold a small pool against this one server.
      "-c",
      "max_connections=200",
      // Throwaway database: durability off. The write-heavy fixture loads
      // are fsync-bound on CI disks.
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      // Scheduler/telemetry workers open their own connections to every
      // database with the extension installed; a connection to the template
      // database would make CREATE DATABASE ... TEMPLATE fail. Tests exercise
      // no timescale jobs, so turn them off.
      "-c",
      "timescaledb.max_background_workers=0",
      "-c",
      "timescaledb.telemetry_level=off",
    ]);

  const container = await (reuse ? builder.withReuse() : builder).start();

  const connection = {
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
  };

  const stale = reuse ? await templateIsStale(connection) : true;

  if (stale && reuse) {
    await withAdmin(connection, async (admin) => {
      await admin.query(
        `DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`,
      );
      await admin.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    });
  }

  const { postgres, hasura } = makeServices(
    { ...connection, database: TEMPLATE_DB },
    loggerName,
  );

  if (stale) {
    // The prod image provisions the timescaledb extension outside the
    // migrations; do the same so create_hypertable migrations resolve.
    await postgres.query("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE");
  }

  // Runs even against an up-to-date template: setup() re-applies the boot-phase
  // files whose digest changed, which is how an edited trigger or view reaches
  // a reused container. With nothing to do it applies zero migrations.
  await hasura.setup();

  if (reuse) {
    await recordTemplateFingerprint(connection);
  }

  if (reuse) {
    await sweepAbandonedClones(connection);
  }

  return {
    container,
    postgres,
    hasura,
    stop: async () => {
      await endPool(postgres);
      if (!reuse) {
        await container?.stop();
      }
    },
  };
}

async function templateIsStale(connection: Connection): Promise<boolean> {
  return await withAdmin(connection, async (admin) => {
    await admin.query(
      `CREATE TABLE IF NOT EXISTS ${FINGERPRINT_TABLE} (fingerprint text NOT NULL)`,
    );
    const { rows } = await admin.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM ${FINGERPRINT_TABLE} LIMIT 1`,
    );
    const [template] = (
      await admin.query<{ exists: boolean }>(
        `SELECT to_regclass('pg_database') IS NOT NULL
                AND EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
        [TEMPLATE_DB],
      )
    ).rows;

    return (
      !template?.exists || rows[0]?.fingerprint !== migrationsFingerprint()
    );
  });
}

async function recordTemplateFingerprint(
  connection: Connection,
): Promise<void> {
  await withAdmin(connection, async (admin) => {
    await admin.query(`DELETE FROM ${FINGERPRINT_TABLE}`);
    await admin.query(`INSERT INTO ${FINGERPRINT_TABLE} VALUES ($1)`, [
      migrationsFingerprint(),
    ]);
  });
}

// Clones from crashed runs would otherwise pile up in a container that now
// outlives the run. Skipped entirely while any clone still has a connection, so
// a second test run against the same container never has its databases pulled
// out from under it.
async function sweepAbandonedClones(connection: Connection): Promise<void> {
  await withAdmin(connection, async (admin) => {
    const { rows: busy } = await admin.query<{ count: string }>(
      `SELECT count(*) AS count FROM pg_stat_activity WHERE datname LIKE 'test\\_%'`,
    );
    if (Number(busy[0].count) > 0) {
      return;
    }

    const { rows } = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'test\\_%'`,
    );
    for (const row of rows) {
      await admin.query(
        `DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`,
      );
    }
  });
}

// Fast path used under test/jest-sql.config.js: the global setup already
// booted one container and migrated the template database, so a suite only
// needs its own copy — CREATE DATABASE ... TEMPLATE is a file-level clone
// that takes a fraction of a second instead of a container boot plus the
// full migration pipeline.
async function cloneFromTemplate(loggerName: string): Promise<SqlTestDb> {
  const connection = connectionFromEnv();

  const database = `test_${loggerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")}_${randomBytes(4).toString("hex")}`;

  await withAdmin(connection, async (admin) => {
    await admin.query("SELECT pg_advisory_lock($1)", [CLONE_LOCK_ID]);
    try {
      await admin.query(
        `CREATE DATABASE "${database}" TEMPLATE ${TEMPLATE_DB}`,
      );
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [CLONE_LOCK_ID]);
    }
  });

  const { postgres, hasura } = makeServices(
    { ...connection, database },
    loggerName,
  );

  return {
    postgres,
    hasura,
    stop: async () => {
      await endPool(postgres);
      // The container now outlives the run, so a clone that is not dropped here
      // stays on disk forever. A failure to drop must not fail the suite.
      try {
        await withAdmin(connection, (admin) =>
          admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
        );
      } catch {
        // The sweep on the next run picks it up.
      }
    },
  };
}

export async function bootMigratedDb(loggerName: string): Promise<SqlTestDb> {
  if (process.env.SQL_TEST_HOST) {
    return cloneFromTemplate(loggerName);
  }
  return bootContainerAndMigrate(loggerName);
}

// Runs fn inside a transaction that carries Hasura session variables, the way
// requests arrive through Hasura. current_setting('hasura.user') is read by
// many triggers, so the config must share the transaction's connection.
export async function runAsUser<T>(
  postgres: PostgresService,
  steamId: string,
  role: string,
  fn: (
    query: (sql: string, params?: Array<unknown>) => Promise<unknown>,
  ) => Promise<T>,
): Promise<T> {
  const pool = (
    postgres as unknown as {
      pool: {
        connect(): Promise<{
          query(sql: string, params?: unknown[]): Promise<{ rows: unknown }>;
          release(): void;
        }>;
      };
    }
  ).pool;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('hasura.user', $1, true)", [
      JSON.stringify({ "x-hasura-role": role, "x-hasura-user-id": steamId }),
    ]);
    const result = await fn((sql, params) =>
      client.query(sql, params as unknown[]).then((r) => r.rows),
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    // A transaction-local set_config leaves the session default as '' (known
    // but empty) rather than unset, and ''::jsonb fails for every later
    // trigger on this pooled connection. Restore a parseable no-user default.
    await client.query("SELECT set_config('hasura.user', '{}', false)");
    client.release();
  }
}

// A fresh install has no server_regions and no servers, but tbi_match's call to
// sanitize_match_options_regions() raises unless at least one region has an
// enabled server attached. Seed one (or more) so matches can be created at all.
export async function seedRegionWithServer(
  postgres: PostgresService,
  region: string,
  port = 27015,
): Promise<void> {
  await postgres.query(
    `INSERT INTO server_regions (value, description)
     VALUES ($1, $1) ON CONFLICT (value) DO NOTHING`,
    [region],
  );
  await postgres.query(
    `INSERT INTO servers (host, label, rcon_password, port, region, type, is_dedicated, enabled)
     VALUES ('127.0.0.1', $1, $2, $3, $1, 'Ranked', true, true)`,
    [region, Buffer.from("password"), port],
  );
}
