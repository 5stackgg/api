import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootContainerAndMigrate, endPool } from "./sql-test-db";

declare global {
   
  var __SQL_TEST_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

// Boots one shared container and runs the full migration pipeline once, into
// the database the suites then clone via CREATE DATABASE ... TEMPLATE. Workers
// inherit process.env, so the connection details travel that way; the
// container handle stays on globalThis for the teardown (same process).
export default async function globalSetup(): Promise<void> {
  const { container, postgres } = await bootContainerAndMigrate(
    "SqlTestTemplate",
  );

  // The template must have zero connections when suites clone from it.
  await endPool(postgres);

  process.env.SQL_TEST_HOST = container!.getHost();
  process.env.SQL_TEST_PORT = String(container!.getPort());
  process.env.SQL_TEST_USER = container!.getUsername();
  process.env.SQL_TEST_PASSWORD = container!.getPassword();

  globalThis.__SQL_TEST_CONTAINER__ = container;
}
