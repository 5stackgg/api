import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  V1Job,
  V1JobStatus,
  V1Pod,
} from "@kubernetes/client-node";
import { PostgresService } from "../postgres/postgres.service";
import { LoggingService } from "../k8s/logging/logging.service";
import { GameServersConfig } from "../configs/types/GameServersConfig";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { MapAssetsQueues } from "./enums/MapAssetsQueues";

export type MapAssetKind = "tri" | "grenadeclip" | "view" | "callouts";

export type MapAssetsManifestEntry = Partial<Record<MapAssetKind, string>> & {
  sha256?: Partial<Record<MapAssetKind, string>>;
  source?: { vpk_sha256?: string; pipeline?: string };
};

export type MapAssetsManifest = {
  version: number;
  build: string;
  created_at?: string;
  maps: Record<string, MapAssetsManifestEntry>;
  failed?: Array<string>;
  failed_view?: Array<string>;
};

export type MapAssetsChangeReason = "vpk" | "pipeline" | "assets";

export type MapAssetsChanges = {
  comparable: boolean;
  total: number;
  added: Array<string>;
  removed: Array<string>;
  rebuilt: Array<{
    map: string;
    reason: MapAssetsChangeReason;
    assets: Array<MapAssetKind>;
  }>;
  unchanged: number;
};

export type MapAssetBuildRun = {
  trigger: "auto" | "manual";
  requestedBy?: string | null;
  requestedByName?: string | null;
  force?: boolean;
};

export type MapAssetsPointer = {
  version: number;
  build: string;
  manifest: string;
};

export type MapAssetBuildStatus =
  | "Pending"
  | "Building"
  | "Published"
  | "Partial"
  | "Failed";

export type MapAssetBuildOutcome = {
  status: "Published" | "Partial" | "Failed";
  manifest: string | null;
  maps: MapAssetsManifest["maps"] | null;
  failed: Array<string> | null;
  failed_view: Array<string> | null;
  error: string | null;
  kept_published?: boolean;
  previous_build_id?: string | null;
  changes?: MapAssetsChanges | null;
  started_at?: Date | string | null;
  finished_at?: Date | string | null;
};

@Injectable()
export class MapAssetsService {
  public static readonly MAPS_HOST = "https://demo-dl.5stack.gg/maps";

  // The last build published before manifests existed. Every consumer falls
  // back to its flat <build>/<map>.* files when latest.json cannot be read, and
  // per asset when the manifest has no entry for it.
  public static readonly PINNED_BUILD = "24957633";

  // Only the assets the pinned build actually carried; views and grenade clips
  // came with manifests, so an unlisted one is simply absent.
  private static readonly PINNED_FILES: Partial<Record<MapAssetKind, string>> =
    {
      tri: ".tri.gz",
      callouts: ".callouts.json",
    };

  public static readonly INDEX_VERSION = 1;

  public static readonly ASSET_KINDS: Array<MapAssetKind> = [
    "tri",
    "grenadeclip",
    "view",
    "callouts",
  ];

  public static readonly IMAGE = "ghcr.io/5stackgg/map-assets:latest";

  public static readonly TIMEOUT_MS = 2 * 60 * 60 * 1000;

  // The publisher exits 2 when it published a manifest but some maps failed
  // (listed in the manifest's failed / failed_view); anything else non-zero
  // means nothing usable was published.
  private static readonly PARTIAL_EXIT_CODE = 2;

  private static readonly POLL_MS = 15_000;

  private static readonly LOG_TAIL_LINES = 40;

  private static readonly MAX_LOG_CHARS = 3000;

  private readonly namespace: string;
  private readonly coreApi: CoreV1Api;
  private readonly batchApi: BatchV1Api;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly postgres: PostgresService,
    private readonly loggingService: LoggingService,
    @InjectQueue(MapAssetsQueues.BuildMapAssets)
    private readonly queue: Queue,
  ) {
    this.namespace =
      this.config.get<GameServersConfig>("gameServers").namespace;

    const kc = new KubeConfig();
    kc.loadFromDefault();

    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.batchApi = kc.makeApiClient(BatchV1Api);
  }

  public static GET_JOB_NAME(buildId: string) {
    return `map-assets-${buildId}`;
  }

  public static GET_QUEUE_JOB_ID(buildId: string) {
    return `map-assets.${buildId}`;
  }

  public static isSafeKey(key: unknown): key is string {
    if (typeof key !== "string" || key.length === 0) {
      return false;
    }

    return key
      .split("/")
      .every(
        (part) =>
          part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part),
      );
  }

  // Per asset, not per map: an entry that exists but lacks this asset (or names
  // an unusable key) falls back exactly as a missing entry does.
  public static assetUrl(
    manifest: MapAssetsManifest | null,
    map: string,
    kind: MapAssetKind,
  ): string | null {
    const entry =
      manifest?.maps && Object.hasOwn(manifest.maps, map)
        ? manifest.maps[map]
        : null;
    const key = entry?.[kind];

    if (MapAssetsService.isSafeKey(key)) {
      return `${MapAssetsService.MAPS_HOST}/${key}`;
    }

    const suffix = MapAssetsService.PINNED_FILES[kind];
    if (!suffix || !MapAssetsService.isSafeKey(map)) {
      return null;
    }

    return `${MapAssetsService.MAPS_HOST}/${MapAssetsService.PINNED_BUILD}/${map}${suffix}`;
  }

  // B2 has no ListBucket grant on these keys, so a missing object can arrive as
  // 403 as well as 404; both mean "not published".
  public static async fetchIndex<T>(key: string): Promise<T | null> {
    const response = await fetch(`${MapAssetsService.MAPS_HOST}/${key}`, {
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 404 || response.status === 403) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`${key} answered ${response.status}`);
    }

    return (await response.json()) as T;
  }

  public static jobSpec(
    gameServerNodeId: string,
    buildId: string,
    force = false,
  ): V1Job {
    const volume = `serverfiles-${gameServerNodeId.replaceAll(".", "-")}`;

    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: MapAssetsService.GET_JOB_NAME(buildId),
        labels: {
          app: "map-assets",
        },
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: MapAssetsService.TIMEOUT_MS / 1000,
        ttlSecondsAfterFinished: 60 * 60 * 24 * 7,
        template: {
          metadata: {
            labels: {
              app: "map-assets",
            },
          },
          spec: {
            affinity: {
              nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        {
                          key: "kubernetes.io/hostname",
                          operator: "In",
                          values: [gameServerNodeId],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            restartPolicy: "Never",
            dnsConfig: {
              options: [
                {
                  name: "ndots",
                  value: "1",
                },
              ],
            },
            containers: [
              {
                name: "map-assets",
                image: MapAssetsService.IMAGE,
                args: [
                  "--cs2",
                  "/serverdata/serverfiles",
                  "--build",
                  buildId,
                  "--out",
                  "/work",
                  "--publish",
                  ...(force ? ["--force"] : []),
                ],
                env: [
                  {
                    name: "S3_ACCESS_KEY",
                    valueFrom: {
                      secretKeyRef: {
                        name: "s3-secrets",
                        key: "S3_ACCESS_KEY",
                      },
                    },
                  },
                  {
                    name: "S3_SECRET",
                    valueFrom: {
                      secretKeyRef: {
                        name: "s3-secrets",
                        key: "S3_SECRET",
                      },
                    },
                  },
                ],
                volumeMounts: [
                  {
                    name: volume,
                    mountPath: "/serverdata/serverfiles",
                    readOnly: true,
                  },
                  {
                    name: "work",
                    mountPath: "/work",
                  },
                  {
                    name: "tmp",
                    mountPath: "/tmp",
                  },
                ],
                // Source2Viewer peaks around 5 GB on rush_001, and the exports
                // it writes before simplification are several GB on disk.
                resources: {
                  requests: {
                    cpu: "1",
                    memory: "4Gi",
                    "ephemeral-storage": "6Gi",
                  },
                  limits: {
                    cpu: "2",
                    memory: "8Gi",
                    "ephemeral-storage": "14Gi",
                  },
                },
              },
            ],
            volumes: [
              {
                name: volume,
                persistentVolumeClaim: {
                  claimName: `${volume}-claim`,
                  readOnly: true,
                },
              },
              {
                name: "work",
                emptyDir: {
                  sizeLimit: "4Gi",
                },
              },
              {
                name: "tmp",
                emptyDir: {
                  sizeLimit: "8Gi",
                },
              },
            ],
          },
        },
      },
    };
  }

  // The automatic path, gated on the public instance and on an operator having
  // turned it on. A build is claimed by inserting its row, so every node
  // reporting the same new build races for one INSERT rather than queueing a
  // job each.
  public async queueBuild(
    gameServerNodeId: string,
    buildId: number,
  ): Promise<boolean> {
    if (process.env.WEB_DOMAIN !== "5stack.gg") {
      return false;
    }

    if (!(await this.autoBuildEnabled())) {
      return false;
    }

    const [current] = await this.postgres.query<Array<{ build_id: number }>>(
      `SELECT build_id
         FROM public.game_versions
        WHERE current = true
          AND build_id = $1`,
      [buildId],
    );

    if (!current) {
      return false;
    }

    const claimed = await this.postgres.query<Array<{ build_id: string }>>(
      `INSERT INTO public.map_asset_builds (build_id, trigger, game_server_node_id)
       VALUES ($1, 'auto', $2)
       ON CONFLICT (build_id) DO NOTHING
       RETURNING build_id`,
      [String(buildId), gameServerNodeId],
    );

    if (!claimed.length) {
      return false;
    }

    try {
      await this.enqueue(gameServerNodeId, String(buildId), {
        trigger: "auto",
      });
    } catch (error) {
      await this.postgres.query(
        `DELETE FROM public.map_asset_builds
          WHERE build_id = $1
            AND status = 'Pending'`,
        [String(buildId)],
      );
      throw error;
    }

    return true;
  }

  // Retries a Partial or Failed build (the publisher rebuilds only the failed
  // maps into a new manifest revision). A Published build is only rebuilt when
  // forced, which rebuilds every map into the next revision. One with a live
  // queue job is already running; a Building row whose job is gone is what an
  // api crash leaves behind, so it may be re-run.
  public async queueManualBuild(
    gameServerNodeId: string,
    buildId: string,
    requester: { steamId: string | null; name?: string | null },
    force = false,
  ): Promise<void> {
    if (process.env.WEB_DOMAIN !== "5stack.gg") {
      throw new Error("Map assets are only built on the 5stack.gg instance");
    }

    const [existing] = await this.postgres.query<
      Array<{
        status: MapAssetBuildStatus;
        trigger: string | null;
        game_server_node_id: string | null;
        requested_by_steam_id: string | null;
        started_at: Date | null;
        finished_at: Date | null;
      }>
    >(
      `SELECT status, trigger, game_server_node_id, requested_by_steam_id,
              started_at, finished_at
         FROM public.map_asset_builds
        WHERE build_id = $1`,
      [buildId],
    );

    if (existing?.status === "Published" && !force) {
      throw new Error(
        `Map assets for build ${buildId} are already published; force a rebuild to build every map again`,
      );
    }

    if (await this.queue.getJob(MapAssetsService.GET_QUEUE_JOB_ID(buildId))) {
      throw new Error(
        `A map-asset build for ${buildId} is already queued or running`,
      );
    }

    await this.postgres.query(
      `INSERT INTO public.map_asset_builds
         (build_id, trigger, game_server_node_id, requested_by_steam_id)
       VALUES ($1, 'manual', $2, $3)
       ON CONFLICT (build_id) DO UPDATE
          SET status = 'Pending',
              error = NULL,
              started_at = NULL,
              finished_at = NULL,
              trigger = 'manual',
              game_server_node_id = EXCLUDED.game_server_node_id,
              requested_by_steam_id = EXCLUDED.requested_by_steam_id`,
      [buildId, gameServerNodeId, requester.steamId],
    );

    try {
      await this.enqueue(gameServerNodeId, buildId, {
        trigger: "manual",
        requestedBy: requester.steamId,
        requestedByName: requester.name ?? null,
        force,
      });
    } catch (error) {
      if (existing) {
        await this.postgres.query(
          `UPDATE public.map_asset_builds
              SET status = $2,
                  trigger = $3,
                  game_server_node_id = $4,
                  requested_by_steam_id = $5,
                  started_at = $6,
                  finished_at = $7
            WHERE build_id = $1
              AND status = 'Pending'`,
          [
            buildId,
            existing.status,
            existing.trigger,
            existing.game_server_node_id,
            existing.requested_by_steam_id,
            existing.started_at,
            existing.finished_at,
          ],
        );
      } else {
        await this.postgres.query(
          `DELETE FROM public.map_asset_builds
            WHERE build_id = $1
              AND status = 'Pending'`,
          [buildId],
        );
      }
      throw error;
    }
  }

  // A job that is still running is attached to rather than replaced: the api
  // restarting mid-build hands the BullMQ job back as stalled, and killing an
  // hour of extraction to start it again would be the wrong answer.
  public async build(
    gameServerNodeId: string,
    buildId: string,
    force = false,
  ): Promise<MapAssetBuildOutcome> {
    const jobName = MapAssetsService.GET_JOB_NAME(buildId);

    const [prior] = await this.postgres.query<
      Array<{ status: MapAssetBuildStatus }>
    >(
      `SELECT status
         FROM public.map_asset_builds
        WHERE build_id = $1`,
      [buildId],
    );

    await this.postgres.query(
      `INSERT INTO public.map_asset_builds
         (build_id, status, started_at, game_server_node_id)
       VALUES ($1, 'Building', now(), $2)
       ON CONFLICT (build_id) DO UPDATE
          SET status = 'Building',
              started_at = CASE
                WHEN map_asset_builds.status = 'Building'
                  THEN map_asset_builds.started_at
                ELSE now()
              END,
              finished_at = NULL,
              error = NULL,
              game_server_node_id = EXCLUDED.game_server_node_id`,
      [buildId, gameServerNodeId],
    );

    let outcome: MapAssetBuildOutcome;

    try {
      const existing = await this.loggingService.getJobStatus(jobName);

      if (!existing?.active || existing.succeeded || existing.failed) {
        await this.startJob(gameServerNodeId, buildId, force);
      }

      outcome = await this.waitForJob(jobName, buildId);
    } catch (error) {
      outcome = MapAssetsService.failed(
        (error as Error)?.message ?? String(error),
      );
    }

    // A forced rebuild that fails leaves the build's published manifest (and
    // latest.json) exactly as they were, so the build is still Published.
    const status =
      outcome.status === "Failed" && prior?.status === "Published"
        ? "Published"
        : outcome.status;

    let previousBuildId: string | null = null;
    let changes: MapAssetsChanges | null = null;

    if (outcome.maps) {
      const [previous] = await this.postgres.query<
        Array<{ build_id: string; maps: MapAssetsManifest["maps"] }>
      >(
        `SELECT build_id, maps
           FROM public.map_asset_builds
          WHERE maps IS NOT NULL
            AND CASE WHEN build_id ~ '^[0-9]+$' THEN build_id::bigint END
                < $1::bigint
          ORDER BY CASE WHEN build_id ~ '^[0-9]+$' THEN build_id::bigint END DESC
          LIMIT 1`,
        [buildId],
      );

      previousBuildId = previous?.build_id ?? null;
      changes = MapAssetsService.diffMaps(outcome.maps, previous?.maps ?? null);
    }

    const [row] = await this.postgres.query<
      Array<{ started_at: Date | null; finished_at: Date | null }>
    >(
      `UPDATE public.map_asset_builds
          SET status = $2,
              finished_at = now(),
              manifest = COALESCE($3, manifest),
              maps = COALESCE($4::jsonb, maps),
              failed = COALESCE($5::jsonb, failed),
              failed_view = COALESCE($6::jsonb, failed_view),
              error = $7,
              previous_build_id = COALESCE($8, previous_build_id),
              changes = COALESCE($9::jsonb, changes)
        WHERE build_id = $1
        RETURNING started_at, finished_at`,
      [
        buildId,
        status,
        outcome.manifest,
        outcome.maps ? JSON.stringify(outcome.maps) : null,
        outcome.failed ? JSON.stringify(outcome.failed) : null,
        outcome.failed_view ? JSON.stringify(outcome.failed_view) : null,
        outcome.error,
        previousBuildId,
        changes ? JSON.stringify(changes) : null,
      ],
    );

    return {
      ...outcome,
      kept_published: status !== outcome.status,
      previous_build_id: previousBuildId,
      changes,
      started_at: row?.started_at ?? null,
      finished_at: row?.finished_at ?? null,
    };
  }

  public static diffMaps(
    current: MapAssetsManifest["maps"],
    previous: MapAssetsManifest["maps"] | null,
  ): MapAssetsChanges {
    const names = Object.keys(current ?? {}).sort();

    if (!previous) {
      return {
        comparable: false,
        total: names.length,
        added: [],
        removed: [],
        rebuilt: [],
        unchanged: 0,
      };
    }

    const added: Array<string> = [];
    const rebuilt: MapAssetsChanges["rebuilt"] = [];
    let unchanged = 0;

    for (const map of names) {
      const after = current[map];
      const before = Object.hasOwn(previous, map) ? previous[map] : undefined;

      if (!before) {
        added.push(map);
        continue;
      }

      const assets = MapAssetsService.ASSET_KINDS.filter(
        (kind) =>
          (before[kind] ?? null) !== (after[kind] ?? null) ||
          (before.sha256?.[kind] ?? null) !== (after.sha256?.[kind] ?? null),
      );

      const vpkChanged =
        !!before.source?.vpk_sha256 &&
        !!after.source?.vpk_sha256 &&
        before.source.vpk_sha256 !== after.source.vpk_sha256;
      const pipelineChanged =
        (before.source?.pipeline ?? null) !== (after.source?.pipeline ?? null);

      if (!assets.length && !vpkChanged && !pipelineChanged) {
        unchanged += 1;
        continue;
      }

      rebuilt.push({
        map,
        reason: vpkChanged ? "vpk" : pipelineChanged ? "pipeline" : "assets",
        assets,
      });
    }

    const removed = Object.keys(previous)
      .filter((map) => !Object.hasOwn(current, map))
      .sort();

    return {
      comparable: true,
      total: names.length,
      added,
      removed,
      rebuilt,
      unchanged,
    };
  }

  private static failed(error: string): MapAssetBuildOutcome {
    return {
      status: "Failed",
      manifest: null,
      maps: null,
      failed: null,
      failed_view: null,
      error,
    };
  }

  private async autoBuildEnabled(): Promise<boolean> {
    const [setting] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.MapAssetsAutoBuild],
    );

    return setting?.value === "true";
  }

  private async enqueue(
    gameServerNodeId: string,
    buildId: string,
    run: MapAssetBuildRun,
  ) {
    await this.queue.add(
      "BuildMapAssets",
      {
        gameServerNodeId,
        buildId,
        ...run,
      },
      {
        jobId: MapAssetsService.GET_QUEUE_JOB_ID(buildId),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  private async startJob(
    gameServerNodeId: string,
    buildId: string,
    force: boolean,
  ) {
    await this.batchApi
      .deleteNamespacedJob({
        name: MapAssetsService.GET_JOB_NAME(buildId),
        namespace: this.namespace,
        propagationPolicy: "Background",
        gracePeriodSeconds: 0,
      })
      .catch((error) => {
        if (error.code?.toString() !== "404") {
          throw error;
        }
      });

    await this.batchApi.createNamespacedJob({
      namespace: this.namespace,
      body: MapAssetsService.jobSpec(gameServerNodeId, buildId, force),
    });
  }

  private async waitForJob(
    jobName: string,
    buildId: string,
  ): Promise<MapAssetBuildOutcome> {
    const deadline = Date.now() + MapAssetsService.TIMEOUT_MS + 5 * 60 * 1000;

    let status: V1JobStatus | undefined;

    while (Date.now() < deadline) {
      status = await this.loggingService.getJobStatus(jobName);
      if (!status || status.succeeded || status.failed) {
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, MapAssetsService.POLL_MS),
      );
    }

    if (status?.succeeded) {
      return {
        ...(await this.publishedManifest(buildId)),
        status: "Published",
        error: null,
      };
    }

    const pod = status?.failed
      ? await this.loggingService.getJobPod(jobName)
      : undefined;

    if (MapAssetsService.exitCode(pod) === MapAssetsService.PARTIAL_EXIT_CODE) {
      return {
        ...(await this.publishedManifest(buildId)),
        status: "Partial",
        error: (await this.logTail(pod)) ?? null,
      };
    }

    return MapAssetsService.failed(
      await this.failureReason(jobName, status, pod),
    );
  }

  // A rebuild of a Partial build publishes a new manifest revision
  // (<build>/manifest.rN.json) and repoints latest.json at it, so latest.json
  // is the authority whenever it names this build.
  private async publishedManifest(
    buildId: string,
  ): Promise<
    Pick<MapAssetBuildOutcome, "manifest" | "maps" | "failed" | "failed_view">
  > {
    try {
      const pointer =
        await MapAssetsService.fetchIndex<MapAssetsPointer>("latest.json");
      const key =
        pointer?.build === buildId &&
        MapAssetsService.isSafeKey(pointer.manifest)
          ? pointer.manifest
          : `${buildId}/manifest.json`;
      const manifest =
        await MapAssetsService.fetchIndex<MapAssetsManifest>(key);

      if (manifest) {
        return {
          manifest: key,
          maps: manifest.maps ?? null,
          failed: manifest.failed ?? [],
          failed_view: manifest.failed_view ?? [],
        };
      }

      this.logger.warn(
        `[map-assets] build ${buildId} finished but ${key} is not published`,
      );
    } catch (error) {
      this.logger.warn(
        `[map-assets] build ${buildId} finished but its manifest could not be read: ${(error as Error)?.message}`,
      );
    }

    return { manifest: null, maps: null, failed: null, failed_view: null };
  }

  private static exitCode(pod: V1Pod | undefined): number | null {
    const terminated = pod?.status?.containerStatuses?.find(
      (containerStatus) => containerStatus.name === "map-assets",
    )?.state?.terminated;

    return terminated ? terminated.exitCode : null;
  }

  private async failureReason(
    jobName: string,
    status: V1JobStatus | undefined,
    pod: V1Pod | undefined,
  ): Promise<string> {
    const reasons: Array<string> = [];

    const failed = status?.conditions?.find(
      (condition) => condition.type === "Failed" && condition.status === "True",
    );

    if (failed) {
      reasons.push([failed.reason, failed.message].filter(Boolean).join(": "));
    } else if (!status) {
      reasons.push(`${jobName} disappeared before it finished`);
    } else {
      reasons.push(
        `${jobName} did not finish within ${MapAssetsService.TIMEOUT_MS / 3_600_000}h`,
      );
    }

    const jobPod = pod ?? (await this.loggingService.getJobPod(jobName));

    const podReason = MapAssetsService.podFailureReason(jobPod);
    if (podReason) {
      reasons.push(podReason);
    }

    const tail = await this.logTail(jobPod);
    if (tail) {
      reasons.push(tail);
    }

    return reasons.filter(Boolean).join("\n");
  }

  private async logTail(pod: V1Pod | undefined): Promise<string | null> {
    if (!pod?.metadata?.name) {
      return null;
    }

    try {
      const logs = await this.coreApi.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.namespace,
        tailLines: MapAssetsService.LOG_TAIL_LINES,
      });
      const tail = String(logs ?? "").trim();
      return tail ? tail.slice(-MapAssetsService.MAX_LOG_CHARS) : null;
    } catch {
      this.logger.warn(`[map-assets] ${pod.metadata.name} produced no logs`);
      return null;
    }
  }

  private static podFailureReason(pod: V1Pod | undefined): string | null {
    if (!pod) {
      return null;
    }

    const statuses = [
      ...(pod.status?.initContainerStatuses ?? []),
      ...(pod.status?.containerStatuses ?? []),
    ];

    for (const containerStatus of statuses) {
      const waiting = containerStatus.state?.waiting;
      if (waiting?.reason) {
        return waiting.message
          ? `${waiting.reason}: ${waiting.message}`
          : waiting.reason;
      }

      const terminated = containerStatus.state?.terminated;
      if (terminated && terminated.exitCode !== 0) {
        return `${terminated.reason ?? "terminated"} (exit ${terminated.exitCode})`;
      }
    }

    const unscheduled = pod.status?.conditions?.find(
      (condition) =>
        condition.type === "PodScheduled" && condition.status === "False",
    );
    if (unscheduled) {
      return unscheduled.message ?? unscheduled.reason ?? "Unschedulable";
    }

    return pod.status?.message ?? null;
  }
}
