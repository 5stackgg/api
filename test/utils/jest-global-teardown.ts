// A reused container is deliberately left running so the next run skips the
// boot and the migration pipeline. `docker rm -f` it, or run with
// SQL_TEST_FRESH=1, to start over.
export default async function globalTeardown(): Promise<void> {
  if (process.env.SQL_TEST_FRESH === "1") {
    await globalThis.__SQL_TEST_CONTAINER__?.stop();
  }
}
