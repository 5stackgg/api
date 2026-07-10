import { randomBytes } from "crypto";
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

export interface SqlTestDb {
  container?: StartedPostgreSqlContainer;
  postgres: PostgresService;
  hasura: HasuraService;
  stop(): Promise<void>;
}

function makeServices(connection: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}, loggerName: string): { postgres: PostgresService; hasura: HasuraService } {
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
export async function bootContainerAndMigrate(
  loggerName: string,
): Promise<SqlTestDb> {
  const container = await new PostgreSqlContainer(IMAGE)
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
      // Scheduler/telemetry workers open their own connections to every
      // database with the extension installed; a connection to the template
      // database would make CREATE DATABASE ... TEMPLATE fail. Tests exercise
      // no timescale jobs, so turn them off.
      "-c",
      "timescaledb.max_background_workers=0",
      "-c",
      "timescaledb.telemetry_level=off",
    ])
    .start();

  // The prod image provisions the timescaledb extension outside the migrations;
  // do the same so create_hypertable migrations resolve.
  const { postgres, hasura } = makeServices(
    {
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    },
    loggerName,
  );
  await postgres.query("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE");

  await hasura.setup();

  return {
    container,
    postgres,
    hasura,
    stop: async () => {
      await endPool(postgres);
      await container?.stop();
    },
  };
}

// Fast path used under test/jest-sql.config.js: the global setup already
// booted one container and migrated the template database, so a suite only
// needs its own copy — CREATE DATABASE ... TEMPLATE is a file-level clone
// that takes a fraction of a second instead of a container boot plus the
// full migration pipeline.
async function cloneFromTemplate(loggerName: string): Promise<SqlTestDb> {
  const connection = {
    host: process.env.SQL_TEST_HOST!,
    port: Number(process.env.SQL_TEST_PORT),
    user: process.env.SQL_TEST_USER!,
    password: process.env.SQL_TEST_PASSWORD!,
  };

  const database = `test_${loggerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")}_${randomBytes(4).toString("hex")}`;

  // CREATE DATABASE cannot run inside a pool/transaction; use a raw client
  // against the maintenance database.
  const admin = new Client({ ...connection, database: "postgres" });
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock($1)", [CLONE_LOCK_ID]);
    try {
      await admin.query(
        `CREATE DATABASE "${database}" TEMPLATE ${TEMPLATE_DB}`,
      );
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [CLONE_LOCK_ID]);
    }
  } finally {
    await admin.end();
  }

  const { postgres, hasura } = makeServices(
    { ...connection, database },
    loggerName,
  );

  return {
    postgres,
    hasura,
    stop: async () => {
      // The shared container outlives the suite (global teardown stops it);
      // clones are cheap and die with it, so dropping them isn't worth a
      // maintenance connection here.
      await endPool(postgres);
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
