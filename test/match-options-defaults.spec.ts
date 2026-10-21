import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { SystemService } from "../src/system/system.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Every settings write re-applies these column defaults, and Hasura can now
// send that event again and again, so the DDL has to be cheap to repeat.
describe("match option defaults from settings (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchOptionsDefaultsTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const system = (settings: Array<{ name: string; value: string }>) =>
    new SystemService(
      {} as any,
      { query: async () => ({ settings }) } as any,
      {} as any,
      new Logger("MatchOptionsDefaultsTest"),
      postgres,
    );

  const columnDefault = async (column: string) => {
    const [row] = await postgres.query<Array<{ column_default: string }>>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'match_options' AND column_name = $1`,
      [column],
    );
    return row.column_default;
  };

  it("sets the defaults the settings describe", async () => {
    await system([
      { name: "public.veto_pick_timeout", value: "45" },
      { name: "public.default_models", value: "true" },
    ]).updateDefaultOptions();

    expect(await columnDefault("veto_pick_timeout")).toBe("45");
    expect(await columnDefault("default_models")).toBe("true");
  });

  it("does not alter the table when the default is already right", async () => {
    const settings = [{ name: "public.veto_pick_timeout", value: "50" }];
    await system(settings).updateDefaultOptions();

    const transaction = jest.spyOn(postgres, "transaction");
    await system(settings).updateDefaultOptions();

    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it("gives up quickly rather than queueing every reader behind a lock it cannot get", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const reader = postgres.transaction(async (client) => {
      await client.query("LOCK TABLE match_options IN ACCESS SHARE MODE");
      locked();
      await held;
    });
    await isLocked;

    const started = Date.now();
    await expect(
      system([
        { name: "public.veto_pick_timeout", value: "55" },
      ]).updateDefaultOptions(),
    ).rejects.toThrow(/lock timeout/);
    expect(Date.now() - started).toBeLessThan(15_000);

    release();
    await reader;
  });
});
