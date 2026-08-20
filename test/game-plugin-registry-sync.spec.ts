import { PostgresService } from "./../src/postgres/postgres.service";
import { GamePluginsService } from "./../src/game-plugins/game-plugins.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// A sync owns the catalog: it upserts what the registry publishes and prunes
// what it does not. A plugin the operator added themselves is the one thing it
// must not touch, or adding a plugin because the registry lacks it would be
// undone by the next poll fifteen minutes later.
describe("game plugin registry sync (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let service: GamePluginsService;
  let published: Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = await bootMigratedDb("GamePluginRegistrySync");
    postgres = db.postgres;

    service = new GamePluginsService(
      { warn: jest.fn(), log: jest.fn() } as never,
      {} as never,
      postgres,
      {} as never,
      {} as never,
      { add: jest.fn(), getJob: jest.fn() } as never,
    );

    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: 1,
        generated_at: new Date().toISOString(),
        plugins: published,
      }),
    })) as never;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM game_plugin_installs");
    await postgres.query("DELETE FROM game_plugin_versions");
    await postgres.query("DELETE FROM game_mode_plugins");
    await postgres.query("DELETE FROM game_plugins");

    published = [
      {
        slug: "retakes",
        kind: "game",
        name: "Retakes",
        author: "someone",
        description: "a catalogued plugin",
        versions: [
          {
            runtime: "swiftlys2",
            version: "1.0.0",
            url: "https://example.test/retakes.zip",
            sha256: "a".repeat(64),
            published_at: new Date().toISOString(),
          },
        ],
      },
    ];
  });

  const addCustom = async (slug = "our-own"): Promise<void> => {
    await postgres.query(
      `INSERT INTO game_plugins (slug, kind, name, author, description, source)
       VALUES ($1, 'game', 'Ours', 'us', 'not in the registry', 'custom')`,
      [slug],
    );
    await postgres.query(
      `INSERT INTO game_plugin_versions
         (plugin_slug, runtime, version, url, sha256, published_at)
       VALUES ($1, 'swiftlys2', '2.0.0', 'https://example.test/ours.zip', $2, now())`,
      [slug, "b".repeat(64)],
    );
  };

  const catalog = async (): Promise<Array<Record<string, any>>> =>
    await postgres.query(
      `SELECT slug, source, name FROM game_plugins ORDER BY slug`,
    );

  it("keeps a plugin the operator added, which the registry has never heard of", async () => {
    await addCustom();

    await service.syncRegistry();

    expect(await catalog()).toEqual([
      expect.objectContaining({ slug: "our-own", source: "custom" }),
      expect.objectContaining({ slug: "retakes", source: "registry" }),
    ]);
  });

  it("keeps the custom plugin's own versions", async () => {
    await addCustom();

    await service.syncRegistry();

    const versions = await postgres.query<Array<{ version: string }>>(
      `SELECT version FROM game_plugin_versions WHERE plugin_slug = 'our-own'`,
    );

    expect(versions.map((row) => row.version)).toEqual(["2.0.0"]);
  });

  it("still prunes a registry plugin that stopped being published", async () => {
    await postgres.query(
      `INSERT INTO game_plugins (slug, kind, name, author, description)
       VALUES ('gone', 'game', 'Gone', 'someone', 'delisted upstream')`,
    );

    await service.syncRegistry();

    expect((await catalog()).map((row) => row.slug)).toEqual(["retakes"]);
  });

  // Same name, two different downloads. The operator's entry is the one an
  // install is already pointing at, so the catalog does not get to take it over.
  it("does not overwrite a custom entry when the registry publishes that slug", async () => {
    await addCustom("retakes");

    await service.syncRegistry();

    expect(await catalog()).toEqual([
      expect.objectContaining({
        slug: "retakes",
        source: "custom",
        name: "Ours",
      }),
    ]);
  });
});
