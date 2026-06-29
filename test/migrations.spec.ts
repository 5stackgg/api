import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { HasuraService } from "./../src/hasura/hasura.service";
import { PostgresService } from "./../src/postgres/postgres.service";

// Boots a throwaway Postgres (same TimescaleDB/PG17 image prod runs) and drives
// the real HasuraService.setup() through the full migration -> enums -> functions
// -> views -> triggers pipeline. This is the path that runs on a fresh install,
// and it is what regresses when an object's type changes underneath a file the
// auto-loader still re-applies (e.g. a view file left behind after the object
// became a table). Asserting it completes guards the cold-start path end to end.
describe("hasura migrations (cold start)", () => {
  // Image, extensions, and connection user mirror production
  // (5stack-panel/base/timescaledb): create_hypertable migrations need
  // TimescaleDB, and setup() calls pg_stat_statements_reset() after migrating,
  // which requires pg_stat_statements in shared_preload_libraries.
  const IMAGE = "timescale/timescaledb:latest-pg17";

  let container: StartedPostgreSqlContainer;
  let postgresService: PostgresService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase("hasura")
      .withUsername("hasura")
      .withPassword("hasura")
      .withCommand([
        "postgres",
        "-c",
        "shared_preload_libraries=timescaledb,pg_stat_statements",
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
      app: {
        demosDomain: "demos.test",
        relayDomain: "relay.test",
      },
    });

    const logger = new Logger("MigrationTest");
    postgresService = new PostgresService(configService, logger);

    // The prod image provisions the timescaledb extension outside the migrations;
    // do the same so create_hypertable migrations resolve.
    await postgresService.query(
      "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE",
    );

    const hasuraService = new HasuraService(
      logger,
      // CacheService is unused by setup(); the GraphQL/cache paths are not exercised.
      null as never,
      configService,
      postgresService,
    );

    await hasuraService.setup();
  }, 600_000);

  afterAll(async () => {
    // Drain the pool before the container goes away, otherwise pg emits an
    // idle-client error when the socket is torn out from under it.
    await (
      postgresService as unknown as { pool: { end(): Promise<void> } }
    )?.pool?.end();
    await container?.stop();
  });

  const relkind = async (name: string) => {
    const rows = await postgresService.query<Array<{ relkind: string }>>(
      "SELECT relkind FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace",
      [name],
    );
    return rows[0]?.relkind;
  };

  // The regression that motivated this test: v_team_stage_results became a
  // trigger-maintained cache table, but a stale CREATE OR REPLACE VIEW file was
  // re-applied over it on cold start and Postgres rejected it. 'r' = ordinary
  // table, 'v' = view.
  it("materializes v_team_stage_results as a table, not a view", async () => {
    expect(await relkind("v_team_stage_results")).toBe("r");
  });

  it("keeps the heavy standings logic as the compute view", async () => {
    expect(await relkind("v_team_stage_results_compute")).toBe("v");
    expect(await relkind("v_team_tournament_results")).toBe("v");
  });
});
