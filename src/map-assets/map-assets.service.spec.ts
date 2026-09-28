import { MapAssetsService } from "./map-assets.service";

describe("MapAssetsService", () => {
  const originalDomain = process.env.WEB_DOMAIN;
  const originalFetch = global.fetch;

  type Db = {
    autoBuild: string | null;
    current: boolean;
    claimed: boolean;
    nodeBuild: number | null;
    existing: string | null;
  };

  let db: Db;
  let postgres: { query: jest.Mock };
  let loggingService: { getJobStatus: jest.Mock; getJobPod: jest.Mock };
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let batchApi: {
    deleteNamespacedJob: jest.Mock;
    createNamespacedJob: jest.Mock;
  };
  let coreApi: { readNamespacedPodLog: jest.Mock };
  let files: Record<string, unknown>;
  let service: MapAssetsService;

  beforeEach(() => {
    process.env.WEB_DOMAIN = "5stack.gg";

    db = {
      autoBuild: "true",
      current: true,
      claimed: true,
      nodeBuild: 25537370,
      existing: null,
    };
    postgres = {
      query: jest.fn(async (sql: string, params: Array<unknown>) => {
        if (sql.includes("FROM public.settings")) {
          return db.autoBuild === null ? [] : [{ value: db.autoBuild }];
        }
        if (sql.includes("FROM public.game_versions")) {
          return db.current ? [{ build_id: params[0] }] : [];
        }
        if (sql.includes("DO NOTHING")) {
          return db.claimed ? [{ build_id: params[0] }] : [];
        }
        if (sql.includes("FROM public.game_server_nodes")) {
          return [{ build_id: db.nodeBuild }];
        }
        if (sql.includes("SELECT status")) {
          return db.existing ? [{ status: db.existing }] : [];
        }
        return [];
      }),
    };
    loggingService = {
      getJobStatus: jest.fn(),
      getJobPod: jest.fn().mockResolvedValue(undefined),
    };
    queue = {
      add: jest.fn().mockResolvedValue({}),
      getJob: jest.fn().mockResolvedValue(undefined),
    };
    batchApi = {
      deleteNamespacedJob: jest.fn().mockResolvedValue({}),
      createNamespacedJob: jest.fn().mockResolvedValue({}),
    };
    coreApi = { readNamespacedPodLog: jest.fn().mockResolvedValue("") };

    files = {};
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
    }) as any;

    service = new MapAssetsService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      { get: () => ({ namespace: "5stack" }) } as any,
      postgres as any,
      loggingService as any,
      queue as any,
    );
    (service as any).batchApi = batchApi;
    (service as any).coreApi = coreApi;
  });

  afterEach(() => {
    process.env.WEB_DOMAIN = originalDomain;
    global.fetch = originalFetch;
  });

  const sqlCalls = () =>
    postgres.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " "));

  describe("jobSpec", () => {
    const job = MapAssetsService.jobSpec("node.one", "25537370");
    const pod = job.spec.template.spec;
    const container = pod.containers[0];

    it("is named for the build so a second run replaces the first", () => {
      expect(job.metadata.name).toBe("map-assets-25537370");
    });

    it("is pinned to the node whose install it reads", () => {
      expect(
        pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
          .nodeSelectorTerms[0].matchExpressions[0],
      ).toEqual({
        key: "kubernetes.io/hostname",
        operator: "In",
        values: ["node.one"],
      });
    });

    it("mounts the node's install read-only and scratch space for the build", () => {
      expect(container.volumeMounts).toEqual([
        {
          name: "serverfiles-node-one",
          mountPath: "/serverdata/serverfiles",
          readOnly: true,
        },
        { name: "work", mountPath: "/work" },
        { name: "tmp", mountPath: "/tmp" },
      ]);
      expect(pod.volumes).toEqual([
        {
          name: "serverfiles-node-one",
          persistentVolumeClaim: {
            claimName: "serverfiles-node-one-claim",
            readOnly: true,
          },
        },
        { name: "work", emptyDir: { sizeLimit: "4Gi" } },
        { name: "tmp", emptyDir: { sizeLimit: "8Gi" } },
      ]);
    });

    it("runs the publisher against that install, writing into /work", () => {
      expect(container.image).toBe("ghcr.io/5stackgg/map-assets:latest");
      expect(container.args).toEqual([
        "--cs2",
        "/serverdata/serverfiles",
        "--build",
        "25537370",
        "--out",
        "/work",
        "--publish",
      ]);
    });

    it("takes the B2 credentials from s3-secrets", () => {
      expect(container.env).toEqual([
        {
          name: "S3_ACCESS_KEY",
          valueFrom: {
            secretKeyRef: { name: "s3-secrets", key: "S3_ACCESS_KEY" },
          },
        },
        {
          name: "S3_SECRET",
          valueFrom: { secretKeyRef: { name: "s3-secrets", key: "S3_SECRET" } },
        },
      ]);
    });

    it("never retries, is killed at the timeout and is kept a week", () => {
      expect(pod.restartPolicy).toBe("Never");
      expect(job.spec.backoffLimit).toBe(0);
      expect(job.spec.activeDeadlineSeconds).toBe(2 * 60 * 60);
      expect(job.spec.ttlSecondsAfterFinished).toBe(60 * 60 * 24 * 7);
    });

    it("is sized for Source2Viewer but bounded so the node's game servers keep running", () => {
      expect(container.resources).toEqual({
        requests: { cpu: "1", memory: "4Gi", "ephemeral-storage": "6Gi" },
        limits: { cpu: "2", memory: "8Gi", "ephemeral-storage": "14Gi" },
      });
    });
  });

  describe("queueBuild", () => {
    it("does nothing off the public instance", async () => {
      process.env.WEB_DOMAIN = "example.com";

      await expect(service.queueBuild("node-1", 25537370)).resolves.toBe(false);
      expect(postgres.query).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each([null, "false"])(
      "stays off until map_assets_auto_build is turned on (%s)",
      async (value) => {
        db.autoBuild = value;

        await expect(service.queueBuild("node-1", 25537370)).resolves.toBe(
          false,
        );
        expect(postgres.query.mock.calls[0][1]).toEqual([
          "map_assets_auto_build",
        ]);
        expect(sqlCalls()).toHaveLength(1);
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it("ignores a build that is not the current one", async () => {
      db.current = false;

      await expect(service.queueBuild("node-1", 25537370)).resolves.toBe(false);
      expect(sqlCalls().some((sql) => sql.includes("INSERT"))).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("does not queue a build that already has a row", async () => {
      db.claimed = false;

      await expect(service.queueBuild("node-1", 25537370)).resolves.toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("claims the build and queues one job per build", async () => {
      await expect(service.queueBuild("node-1", 25537370)).resolves.toBe(true);
      expect(queue.add).toHaveBeenCalledWith(
        "BuildMapAssets",
        { gameServerNodeId: "node-1", buildId: "25537370" },
        expect.objectContaining({
          jobId: "map-assets.25537370",
          attempts: 1,
        }),
      );
    });

    it("releases the claim when the job cannot be queued", async () => {
      queue.add.mockRejectedValueOnce(new Error("redis down"));

      await expect(service.queueBuild("node-1", 25537370)).rejects.toThrow(
        "redis down",
      );
      const release = sqlCalls().at(-1);
      expect(release).toContain("DELETE FROM public.map_asset_builds");
      expect(release).toContain("status = 'Pending'");
    });
  });

  describe("queueManualBuild", () => {
    it("does nothing off the public instance", async () => {
      process.env.WEB_DOMAIN = "example.com";

      await expect(service.queueManualBuild("node-1")).resolves.toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("ignores the automatic-build setting", async () => {
      db.autoBuild = null;

      await expect(service.queueManualBuild("node-1")).resolves.toBe(true);
      expect(sqlCalls().some((sql) => sql.includes("public.settings"))).toBe(
        false,
      );
    });

    it("needs the node to have reported a build", async () => {
      db.nodeBuild = null;

      await expect(service.queueManualBuild("node-1")).resolves.toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each(["Partial", "Failed", "Pending"])(
      "retries a %s build",
      async (status) => {
        db.existing = status;

        await expect(service.queueManualBuild("node-1")).resolves.toBe(true);
        expect(sqlCalls().at(-1)).toContain("SET status = 'Pending'");
        expect(queue.add).toHaveBeenCalledWith(
          "BuildMapAssets",
          { gameServerNodeId: "node-1", buildId: "25537370" },
          expect.objectContaining({ jobId: "map-assets.25537370" }),
        );
      },
    );

    it("leaves a published build alone", async () => {
      db.existing = "Published";

      await expect(service.queueManualBuild("node-1")).resolves.toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("does not start a second run while one is queued or running", async () => {
      db.existing = "Building";
      queue.getJob.mockResolvedValueOnce({ id: "map-assets.25537370" });

      await expect(service.queueManualBuild("node-1")).resolves.toBe(false);
      expect(queue.getJob).toHaveBeenCalledWith("map-assets.25537370");
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("recovers a Building row whose job is gone", async () => {
      db.existing = "Building";

      await expect(service.queueManualBuild("node-1")).resolves.toBe(true);
    });
  });

  describe("build", () => {
    const maps = {
      de_mirage: {
        tri: "25537370/de_mirage.tri.gz",
        callouts: "25000000/de_mirage.callouts.json",
      },
    };

    const finalUpdate = () => {
      const call = postgres.query.mock.calls.at(-1);
      return { sql: String(call[0]), params: call[1] };
    };

    const finished = (status: Record<string, unknown>) => {
      loggingService.getJobStatus
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(status);
    };

    const exited = (exitCode: number) => {
      loggingService.getJobPod.mockResolvedValue({
        metadata: { name: "map-assets-25537370-abcde" },
        status: {
          containerStatuses: [
            {
              name: "map-assets",
              state: { terminated: { exitCode, reason: "Error" } },
            },
          ],
        },
      });
    };

    it("reads the manifest revision latest.json names for this build", async () => {
      finished({ succeeded: 1 });
      files["latest.json"] = {
        version: 1,
        build: "25537370",
        manifest: "25537370/manifest.r2.json",
      };
      files["25537370/manifest.r2.json"] = {
        version: 1,
        build: "25537370",
        maps,
      };

      const outcome = await service.build("node-1", "25537370");

      expect(batchApi.createNamespacedJob).toHaveBeenCalledWith({
        namespace: "5stack",
        body: MapAssetsService.jobSpec("node-1", "25537370"),
      });
      expect(outcome).toEqual({
        status: "Published",
        manifest: "25537370/manifest.r2.json",
        maps,
        failed: [],
        failed_view: [],
        error: null,
      });
      expect(finalUpdate().params).toEqual([
        "25537370",
        "Published",
        "25537370/manifest.r2.json",
        JSON.stringify(maps),
        "[]",
        "[]",
        null,
      ]);
    });

    it("reads the build's first manifest when latest.json names another build", async () => {
      finished({ succeeded: 1 });
      files["latest.json"] = {
        version: 1,
        build: "25600000",
        manifest: "25600000/manifest.json",
      };
      files["25537370/manifest.json"] = { version: 1, build: "25537370", maps };

      const outcome = await service.build("node-1", "25537370");

      expect(outcome.manifest).toBe("25537370/manifest.json");
      expect(outcome.maps).toEqual(maps);
    });

    it("records a partial publish with the maps that failed", async () => {
      finished({
        failed: 1,
        conditions: [
          { type: "Failed", status: "True", reason: "BackoffLimitExceeded" },
        ],
      });
      exited(2);
      coreApi.readNamespacedPodLog.mockResolvedValue(
        "de_anubis: Source2Viewer-CLI exited 134\n",
      );
      files["latest.json"] = {
        version: 1,
        build: "25537370",
        manifest: "25537370/manifest.json",
      };
      files["25537370/manifest.json"] = {
        version: 1,
        build: "25537370",
        maps,
        failed: ["de_anubis"],
        failed_view: ["de_vertigo"],
      };

      const outcome = await service.build("node-1", "25537370");

      expect(outcome).toMatchObject({
        status: "Partial",
        manifest: "25537370/manifest.json",
        maps,
        failed: ["de_anubis"],
        failed_view: ["de_vertigo"],
      });
      expect(outcome.error).toContain("Source2Viewer-CLI exited 134");
      expect(finalUpdate().params[1]).toBe("Partial");
    });

    it("records why a failed job failed", async () => {
      finished({
        failed: 1,
        conditions: [
          {
            type: "Failed",
            status: "True",
            reason: "BackoffLimitExceeded",
            message: "Job has reached the specified backoff limit",
          },
        ],
      });
      exited(1);
      coreApi.readNamespacedPodLog.mockResolvedValue(
        "extracting de_mirage\nupload refused\n",
      );

      const outcome = await service.build("node-1", "25537370");

      expect(outcome.status).toBe("Failed");
      expect(outcome.error).toContain("BackoffLimitExceeded");
      expect(outcome.error).toContain("Error (exit 1)");
      expect(outcome.error).toContain("upload refused");
      expect(global.fetch).not.toHaveBeenCalled();
      const update = finalUpdate();
      expect(update.params[1]).toBe("Failed");
      expect(update.sql).toContain("maps = COALESCE($4::jsonb, maps)");
    });

    it("attaches to a job that is still running instead of restarting it", async () => {
      loggingService.getJobStatus
        .mockResolvedValueOnce({ active: 1 })
        .mockResolvedValueOnce({ succeeded: 1 });

      const outcome = await service.build("node-1", "25537370");

      expect(batchApi.deleteNamespacedJob).not.toHaveBeenCalled();
      expect(batchApi.createNamespacedJob).not.toHaveBeenCalled();
      expect(outcome.status).toBe("Published");
    });

    it("marks the build failed when the job cannot be created", async () => {
      loggingService.getJobStatus.mockResolvedValueOnce(undefined);
      batchApi.createNamespacedJob.mockRejectedValueOnce(
        new Error("forbidden"),
      );

      const outcome = await service.build("node-1", "25537370");

      expect(outcome).toMatchObject({ status: "Failed", error: "forbidden" });
      expect(finalUpdate().sql).toContain("UPDATE public.map_asset_builds");
    });
  });

  describe("assetUrl", () => {
    const manifest = {
      version: 1,
      build: "25537370",
      maps: {
        de_mirage: {
          tri: "25537370/de_mirage.tri.gz",
          callouts: "25000000/de_mirage.callouts.json",
          view: "25537370/de_mirage.view.bin.gz",
        },
        de_nuke: { callouts: "25537370/de_nuke.callouts.json" },
        de_bad: { callouts: "../../secret.json", tri: "/etc/passwd" },
      },
    };
    const pinned = "https://demo-dl.5stack.gg/maps/24957633";

    it("resolves a manifest key under the maps root", () => {
      expect(MapAssetsService.assetUrl(manifest, "de_mirage", "callouts")).toBe(
        "https://demo-dl.5stack.gg/maps/25000000/de_mirage.callouts.json",
      );
    });

    it("falls back per asset, so an entry without a tri keeps the pinned tri", () => {
      expect(MapAssetsService.assetUrl(manifest, "de_nuke", "tri")).toBe(
        `${pinned}/de_nuke.tri.gz`,
      );
      expect(MapAssetsService.assetUrl(manifest, "de_nuke", "callouts")).toBe(
        "https://demo-dl.5stack.gg/maps/25537370/de_nuke.callouts.json",
      );
    });

    it("falls back to the pinned build for a map the manifest does not list", () => {
      expect(MapAssetsService.assetUrl(manifest, "de_dust2", "callouts")).toBe(
        `${pinned}/de_dust2.callouts.json`,
      );
      expect(MapAssetsService.assetUrl(null, "de_dust2", "tri")).toBe(
        `${pinned}/de_dust2.tri.gz`,
      );
      expect(
        MapAssetsService.assetUrl(manifest, "constructor", "callouts"),
      ).toBe(`${pinned}/constructor.callouts.json`);
    });

    it("never falls back for assets the pinned build never had", () => {
      expect(MapAssetsService.assetUrl(manifest, "de_nuke", "view")).toBe(null);
      expect(
        MapAssetsService.assetUrl(manifest, "de_mirage", "grenadeclip"),
      ).toBe(null);
    });

    it("treats a key that would leave the maps root as unlisted", () => {
      expect(MapAssetsService.assetUrl(manifest, "de_bad", "callouts")).toBe(
        `${pinned}/de_bad.callouts.json`,
      );
      expect(MapAssetsService.assetUrl(manifest, "de_bad", "tri")).toBe(
        `${pinned}/de_bad.tri.gz`,
      );
      expect(MapAssetsService.assetUrl(manifest, "../x", "tri")).toBe(null);
    });
  });
});
