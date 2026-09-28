import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../src/hasura/hasura.service";
import { PostgresService } from "../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// CLOUDFLARE_WORKER_DOMAIN in the panel's config is copied into the
// cloudflare_worker_url setting at boot, which every download URL is built from.
describe("cloudflare worker url setting", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("CloudflareWorkerUrlTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query(
      "DELETE FROM settings WHERE name = 'cloudflare_worker_url'",
    );
  });

  const boot = (cloudflareWorkerUrl?: string) => {
    const hasura = new HasuraService(
      new Logger("CloudflareWorkerUrlTest"),
      null as never,
      new ConfigService({
        app: {
          demosDomain: "demos.test",
          relayDomain: "relay.test",
          cloudflareWorkerUrl,
        },
      }),
      postgres,
    );
    return (
      hasura as unknown as { updateSettings(): Promise<void> }
    ).updateSettings();
  };

  const workerUrl = async () => {
    const rows = await postgres.query<Array<{ value: string }>>(
      "SELECT value FROM settings WHERE name = 'cloudflare_worker_url'",
    );
    return rows.at(0)?.value;
  };

  it("sets the worker url from the panel config", async () => {
    await boot("https://cf.example.test");

    expect(await workerUrl()).toBe("https://cf.example.test");
  });

  it("replaces a url saved from the settings page", async () => {
    await postgres.query(
      "INSERT INTO settings (name, value) VALUES ('cloudflare_worker_url', 'https://demo-dl.example.test')",
    );

    await boot("https://cf.example.test");

    expect(await workerUrl()).toBe("https://cf.example.test");
  });

  it("leaves a saved url alone when the panel config has none", async () => {
    await postgres.query(
      "INSERT INTO settings (name, value) VALUES ('cloudflare_worker_url', 'https://demo-dl.example.test')",
    );

    await boot(undefined);

    expect(await workerUrl()).toBe("https://demo-dl.example.test");
  });

  it("does not create the setting when the panel config has none", async () => {
    await boot(undefined);

    expect(await workerUrl()).toBeUndefined();
  });
});
