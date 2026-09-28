import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { MapAssetsService } from "./../src/map-assets/map-assets.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// One row per CS2 build, claimed by whichever node reports the build first;
// every other node reporting it must not queue a second build.
describe("map asset builds (SQL-driven)", () => {
  const originalDomain = process.env.WEB_DOMAIN;
  const originalFetch = global.fetch;

  let db: SqlTestDb;
  let postgres: PostgresService;
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let loggingService: { getJobStatus: jest.Mock; getJobPod: jest.Mock };

  beforeAll(async () => {
    db = await bootMigratedDb("MapAssetBuildsTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    process.env.WEB_DOMAIN = "5stack.gg";
    await postgres.query("DELETE FROM map_asset_builds");
    await postgres.query("DELETE FROM game_server_nodes");
    await postgres.query("DELETE FROM game_versions");
    await postgres.query(
      "DELETE FROM settings WHERE name = 'map_assets_auto_build'",
    );
    await postgres.query(
      `INSERT INTO server_regions (value, description)
       VALUES ('TestRegion', 'TestRegion') ON CONFLICT (value) DO NOTHING`,
    );
    await postgres.query(
      `INSERT INTO game_versions (build_id, version, description, current, updated_at)
       VALUES (25537370, '1.0', 'current', true, now()),
              (24957633, '0.9', 'previous', null, now())`,
    );
    await postgres.query(
      `INSERT INTO game_server_nodes (id, status, enabled, region, build_id)
       VALUES ('node-a', 'Online', true, 'TestRegion', 25537370)`,
    );
    queue = {
      add: jest.fn().mockResolvedValue({}),
      getJob: jest.fn().mockResolvedValue(undefined),
    };
    loggingService = {
      getJobStatus: jest.fn(),
      getJobPod: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    process.env.WEB_DOMAIN = originalDomain;
    global.fetch = originalFetch;
  });

  const enableAutoBuild = async () => {
    await postgres.query(
      `INSERT INTO settings (name, value) VALUES ('map_assets_auto_build', 'true')`,
    );
  };

  const service = () => {
    const mapAssets = new MapAssetsService(
      new Logger("MapAssetBuildsTest"),
      { get: () => ({ namespace: "5stack" }) } as never,
      postgres,
      loggingService as never,
      queue as never,
    );
    (mapAssets as any).batchApi = {
      deleteNamespacedJob: jest.fn().mockResolvedValue({}),
      createNamespacedJob: jest.fn().mockResolvedValue({}),
    };
    (mapAssets as any).coreApi = {
      readNamespacedPodLog: jest.fn().mockResolvedValue("de_anubis failed\n"),
    };
    return mapAssets;
  };

  const serve = (files: Record<string, unknown>) => {
    global.fetch = jest.fn(async (url: string) => {
      const key = url.replace("https://demo-dl.5stack.gg/maps/", "");
      if (!(key in files)) {
        return {
          ok: false,
          status: 404,
          json: async (): Promise<unknown> => null,
        };
      }
      return { ok: true, status: 200, json: async () => files[key] };
    }) as never;
  };

  const row = async (buildId: string) => {
    const [found] = await postgres.query<
      Array<{
        status: string;
        manifest: string | null;
        maps: unknown;
        failed: Array<string> | null;
        failed_view: Array<string> | null;
        error: string | null;
        started_at: Date | null;
        finished_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>
    >(
      `SELECT status, manifest, maps, failed, failed_view, error,
              started_at, finished_at, created_at, updated_at
         FROM map_asset_builds
        WHERE build_id = $1`,
      [buildId],
    );
    return found;
  };

  it("does not build automatically until an operator turns it on", async () => {
    await expect(service().queueBuild("node-a", 25537370)).resolves.toBe(false);
    expect(await row("25537370")).toBeUndefined();

    await expect(service().queueManualBuild("node-a")).resolves.toBe(true);
    expect((await row("25537370")).status).toBe("Pending");
  });

  it("claims the current build once, however many nodes report it", async () => {
    await enableAutoBuild();
    const mapAssets = service();

    await expect(mapAssets.queueBuild("node-a", 25537370)).resolves.toBe(true);
    await expect(mapAssets.queueBuild("node-b", 25537370)).resolves.toBe(false);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((await row("25537370")).status).toBe("Pending");
  });

  it("ignores a build that is not the current one", async () => {
    await enableAutoBuild();

    await expect(service().queueBuild("node-a", 24957633)).resolves.toBe(false);
    expect(await row("24957633")).toBeUndefined();
  });

  it("only knows the five lifecycle states", async () => {
    await expect(
      postgres.query(
        `INSERT INTO map_asset_builds (build_id, status) VALUES ('1', 'Done')`,
      ),
    ).rejects.toThrow(/map_asset_builds_status_check/);
    await postgres.query(
      `INSERT INTO map_asset_builds (build_id, status) VALUES ('2', 'Partial')`,
    );
  });

  it.each(["Failed", "Partial"])(
    "retries a %s build by hand",
    async (status) => {
      await postgres.query(
        `INSERT INTO map_asset_builds (build_id, status, error)
         VALUES ('25537370', $1, 'boom')`,
        [status],
      );

      await expect(service().queueManualBuild("node-a")).resolves.toBe(true);
      expect(await row("25537370")).toMatchObject({
        status: "Pending",
        error: null,
      });
    },
  );

  it("leaves a published build, or one already running, alone", async () => {
    await postgres.query(
      `INSERT INTO map_asset_builds (build_id, status) VALUES ('25537370', 'Published')`,
    );
    await expect(service().queueManualBuild("node-a")).resolves.toBe(false);

    await postgres.query(
      `UPDATE map_asset_builds SET status = 'Building' WHERE build_id = '25537370'`,
    );
    queue.getJob.mockResolvedValueOnce({ id: "map-assets.25537370" });
    await expect(service().queueManualBuild("node-a")).resolves.toBe(false);
    expect((await row("25537370")).status).toBe("Building");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("records a published build and the manifest revision it came from", async () => {
    const maps = { de_mirage: { tri: "25000000/de_mirage.tri.gz" } };
    await postgres.query(
      `INSERT INTO map_asset_builds (build_id, created_at, updated_at)
       VALUES ('25537370', now() - interval '1 day', now() - interval '1 day')`,
    );
    loggingService.getJobStatus
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ succeeded: 1 });
    serve({
      "latest.json": {
        version: 1,
        build: "25537370",
        manifest: "25537370/manifest.r2.json",
      },
      "25537370/manifest.r2.json": { version: 1, build: "25537370", maps },
    });

    await service().build("node-a", "25537370");

    const published = await row("25537370");
    expect(published).toMatchObject({
      status: "Published",
      manifest: "25537370/manifest.r2.json",
      maps,
      failed: [],
      failed_view: [],
      error: null,
    });
    expect(published.started_at).toBeInstanceOf(Date);
    expect(published.finished_at).toBeInstanceOf(Date);
    expect(published.updated_at.getTime()).toBeGreaterThan(
      published.created_at.getTime() + 60 * 60 * 1000,
    );
  });

  it("records a partial publish, and keeps it when the retry fails outright", async () => {
    const maps = { de_mirage: { tri: "25537370/de_mirage.tri.gz" } };
    loggingService.getJobStatus
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ failed: 1 });
    loggingService.getJobPod.mockResolvedValue({
      metadata: { name: "map-assets-25537370-abcde" },
      status: {
        containerStatuses: [
          {
            name: "map-assets",
            state: { terminated: { exitCode: 2, reason: "Error" } },
          },
        ],
      },
    });
    serve({
      "latest.json": {
        version: 1,
        build: "25537370",
        manifest: "25537370/manifest.json",
      },
      "25537370/manifest.json": {
        version: 1,
        build: "25537370",
        maps,
        failed: ["de_anubis"],
        failed_view: [],
      },
    });

    await service().build("node-a", "25537370");

    expect(await row("25537370")).toMatchObject({
      status: "Partial",
      manifest: "25537370/manifest.json",
      maps,
      failed: ["de_anubis"],
      failed_view: [],
      error: "de_anubis failed",
    });

    loggingService.getJobStatus
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    await service().build("node-a", "25537370");

    const retried = await row("25537370");
    expect(retried.status).toBe("Failed");
    expect(retried.maps).toEqual(maps);
    expect(retried.failed).toEqual(["de_anubis"]);
  });
});
