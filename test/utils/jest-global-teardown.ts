export default async function globalTeardown(): Promise<void> {
  await globalThis.__SQL_TEST_CONTAINER__?.stop();
}
