import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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

export interface SqlTestDb {
  container: StartedPostgreSqlContainer;
  postgres: PostgresService;
  hasura: HasuraService;
  stop(): Promise<void>;
}

// Boots a throwaway Postgres and drives the real HasuraService.setup() through
// the full migration -> enums -> functions -> views -> triggers pipeline, so
// trigger/function behavior under test matches a fresh install exactly.
export async function bootMigratedDb(loggerName: string): Promise<SqlTestDb> {
  const container = await new PostgreSqlContainer(IMAGE)
    .withDatabase("hasura")
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
    ])
    .start();

  const configService = new ConfigService({
    postgres: {
      connections: {
        default: {
          host: container.getHost(),
          port: container.getPort(),
          user: container.getUsername(),
          password: container.getPassword(),
          database: container.getDatabase(),
          max: 5,
        },
      },
    },
    app: { demosDomain: "demos.test", relayDomain: "relay.test" },
  });

  const logger = new Logger(loggerName);
  const postgres = new PostgresService(configService, logger);

  // The prod image provisions the timescaledb extension outside the migrations;
  // do the same so create_hypertable migrations resolve.
  await postgres.query("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE");

  const hasuraService = new HasuraService(
    logger,
    // CacheService is unused by setup(); the GraphQL/cache paths are not exercised.
    null as never,
    configService,
    postgres,
  );

  await hasuraService.setup();

  return {
    container,
    postgres,
    hasura: hasuraService,
    stop: async () => {
      // Drain the pool before the container goes away, otherwise pg emits an
      // idle-client error when the socket is torn out from under it.
      await (
        postgres as unknown as { pool: { end(): Promise<void> } }
      )?.pool?.end();
      await container?.stop();
    },
  };
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
