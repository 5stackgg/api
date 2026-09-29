import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { e_game_server_node_statuses_enum } from "../../generated";
import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
  V1Job,
  V1Pod,
} from "@kubernetes/client-node";
import { GameServersConfig } from "src/configs/types/GameServersConfig";
import { ConfigService } from "@nestjs/config";
import { GpuDevice, NodeStats } from "./interfaces/NodeStats";
import { PodStats } from "./interfaces/PodStats";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { Redis } from "ioredis";
import { LoggingService } from "src/k8s/logging/logging.service";
import { PassThrough } from "stream";
import { SteamConfig } from "src/configs/types/SteamConfig";
import { isJsonEqual } from "@utilities/isJsonEqual";
import { NodeDisk } from "./interfaces/NodeDisk";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { GameServerQueues } from "./enums/GameServerQueues";
import { NotificationsService } from "src/notifications/notifications.service";
import { PluginRuntimeService } from "src/plugin-runtime/plugin-runtime.service";
import { PluginRuntime } from "src/configs/types/GameServersConfig";
import { MapAssetsService } from "src/map-assets/map-assets.service";
import { PostgresService } from "src/postgres/postgres.service";

export type GamedataValidationRuntime = PluginRuntime;

export type GamedataValidationEntry = {
  set: string;
  runtimes?: Array<GamedataValidationRuntime>;
  signature: string;
  kind?: "signature" | "vtable" | "patch";
  count: number | null;
  ok?: boolean | null;
  skipped?: boolean;
  reason?: string;
};

export type GamedataValidationResult = {
  build_id?: number | null;
  status: "pass" | "fail" | "error";
  statuses?: Record<string, string | null>;
  swiftly?: { version?: string | null; error?: string | null } | null;
  broken: Array<GamedataValidationEntry>;
  warnings?: Array<GamedataValidationEntry>;
  skipped?: Array<GamedataValidationEntry>;
  results?: Array<GamedataValidationEntry>;
  error?: string;
};

export type GamedataChangeEntry = {
  set: string;
  kind: string;
  signature: string;
  runtimes: Array<GamedataValidationRuntime>;
  previous_count: number | null;
  count: number | null;
};

export type GamedataValidationChanges = {
  comparable: boolean;
  counts: {
    checked: number;
    broken: number;
    warnings: number;
    skipped: number;
  };
  newly_broken: Array<GamedataChangeEntry>;
  fixed: Array<GamedataChangeEntry>;
  new_warnings: Array<GamedataChangeEntry>;
  cleared_warnings: Array<GamedataChangeEntry>;
};

export type GamedataValidationOutcome = {
  result: GamedataValidationResult;
  previousBuildId: number | null;
  changes: GamedataValidationChanges | null;
};

export type BuildRunTrigger = "auto" | "manual";

export type BuildRun = {
  trigger: BuildRunTrigger;
  requestedBy?: string | null;
};

export type BuildNodeCandidate = {
  id: string;
  label: string | null;
  status: string | null;
  enabled: boolean | null;
  build_id: number | null;
  update_status: string | null;
  gpu: boolean | null;
  enabled_for_match_making: boolean | null;
};

@Injectable()
export class GameServerNodeService {
  private redis: Redis;
  private steamConfig: SteamConfig;
  private gameServerConfig: GameServersConfig;

  private readonly namespace: string;

  private coreApi: CoreV1Api;
  private batchApi: BatchV1Api;

  // nodes (`${nodeId}:${game}`) with an active update-status monitor loop
  private activeUpdateMonitors = new Set<string>();

  // keep 1.5 hours of stats; with a ping every 30 seconds, that's 3,600 / 30 = 120 per hour, so 1.5 * 120 = 180 entries.
  private maxOfflineStatsHistory = 60 * 90;
  private maxStatsHistory: number = 180 - 1;

  constructor(
    protected readonly logger: Logger,
    protected readonly config: ConfigService,
    protected readonly hasura: HasuraService,
    redisManager: RedisManagerService,
    protected readonly loggingService: LoggingService,
    protected readonly notifications: NotificationsService,
    protected readonly pluginRuntimeService: PluginRuntimeService,
    protected readonly mapAssets: MapAssetsService,
    protected readonly postgres: PostgresService,
    @InjectQueue(GameServerQueues.ValidateGamedata)
    private readonly validateGamedataQueue: Queue,
  ) {
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.namespace = this.gameServerConfig.namespace;
    this.redis = redisManager.getConnection();
    this.steamConfig = this.config.get<SteamConfig>("steam");

    const kc = new KubeConfig();
    kc.loadFromDefault();

    this.coreApi = kc.makeApiClient(CoreV1Api);
    this.batchApi = kc.makeApiClient(BatchV1Api);
  }

  // long enough to read a failed update's logs; the monitor deletes succeeded jobs itself
  private static readonly UPDATE_JOB_TTL_S = 24 * 60 * 60;

  // a k8s log follow can stall without ever ending, so stop waiting on it and re-check the job
  private static readonly UPDATE_LOG_IDLE_MS = 60 * 1000;

  private static readonly UPDATE_RESULT_RECORDED_ANNOTATION =
    "5stack.gg/update-result-recorded";

  public static GET_UPDATE_JOB_NAME(gameServerNodeId: string, game = "cs2") {
    const sanitized = gameServerNodeId.replaceAll(".", "-");
    return game === "csgo"
      ? `update-csgo-server-${sanitized}`
      : `update-cs-server-${sanitized}`;
  }

  public static GET_NODE_STATS_KEY(nodeId: string) {
    return `node-stats-v9:${nodeId}`;
  }

  public async create(
    token?: string,
    node?: string,
    status: e_game_server_node_statuses_enum = "Setup",
  ) {
    const regions = await this.hasura.query({
      server_regions: {
        __args: {
          where: {
            _or: [
              {
                value: {
                  _eq: "LAN",
                },
              },
              {
                is_lan: {
                  _eq: true,
                },
              },
            ],
          },
        },
        value: true,
      },
    });

    let lanRegion = regions.server_regions.at(0)?.value;

    if (!lanRegion) {
      const createdLanRegion = await this.hasura.mutation({
        insert_server_regions_one: {
          __args: {
            object: {
              value: "LAN",
              description: "LAN",
              is_lan: true,
            },
          },
          value: true,
        },
      });

      lanRegion = createdLanRegion.insert_server_regions_one.value;
    }

    const { insert_game_server_nodes_one } = await this.hasura.mutation({
      insert_game_server_nodes_one: {
        __args: {
          object: {
            id: node,
            token,
            status,
            region: lanRegion,
          },
        },
        id: true,
        token: true,
      },
    });

    return insert_game_server_nodes_one;
  }

  public async updateStatus(
    node: string,
    nodeIP: string,
    lanIP: string,
    publicIP: string,
    csBulid: number,
    csgoBuildId: number,
    supportsCpuPinning: boolean,
    supportsLowLatency: boolean,
    cpuInfo: {
      sockets: number;
      coresPerSocket: number;
      threadsPerCore: number;
    },
    cpuGovernorInfo: {
      governor: string;
      cpus: Record<number, string>;
    },
    cpuFrequencyInfo: {
      cpus: Record<number, number>;
      frequency: number;
    },
    gpu:
      | {
          count?: number;
          devices?: Array<GpuDevice> | null;
        }
      | undefined,
    status: e_game_server_node_statuses_enum,
    rootDisk?: NodeDisk,
    cpuWarnings: Array<string> = [],
  ) {
    const gpuDevicesAll = gpu?.devices ?? null;
    const hasGpu = (gpu?.count ?? 0) > 0 || (gpuDevicesAll?.length ?? 0) > 0;
    const gpuDevices = gpuDevicesAll
      ? gpuDevicesAll.map((device) => ({
          index: device.index,
          name: device.name,
          ...(device.memory_mb !== undefined
            ? { memory_mb: device.memory_mb }
            : {}),
        }))
      : null;
    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: {
          id: node,
        },
        token: true,
        status: true,
        label: true,
        offline_at: true,
        lan_ip: true,
        node_ip: true,
        build_id: true,
        csgo_build_id: true,
        public_ip: true,
        gpu: true,
        gpu_info: true,
        cpu_sockets: true,
        cpu_cores_per_socket: true,
        cpu_threads_per_core: true,
        supports_low_latency: true,
        supports_cpu_pinning: true,
        cpu_governor_info: true,
        cpu_frequency_info: true,
        cpu_warnings: true,
        update_status: true,
      },
    });

    if (csBulid && game_server_nodes_by_pk?.build_id === undefined) {
      this.logger.log(`Creating volumes for node ${node}`);
      await this.createVolumes(node);
    }
    if (game_server_nodes_by_pk?.status === "NotAcceptingNewMatches") {
      status = "NotAcceptingNewMatches";
    }

    if (!game_server_nodes_by_pk) {
      await this.create(undefined, node, status);
      return;
    }

    const storedStatus = game_server_nodes_by_pk.status;
    const label = game_server_nodes_by_pk.label;
    const offlineAt = game_server_nodes_by_pk.offline_at;

    let transitionedFromOffline = false;
    if (
      status === "Online" &&
      (storedStatus === "Offline" || storedStatus === "Setup")
    ) {
      const { update_game_server_nodes } = await this.hasura.mutation({
        update_game_server_nodes: {
          __args: {
            where: {
              id: { _eq: node },
              status: { _in: ["Offline", "Setup"] },
            },
            _set: {
              status: "Online",
              offline_at: null,
            },
          },
          affected_rows: true,
        },
      });
      transitionedFromOffline =
        storedStatus === "Offline" &&
        update_game_server_nodes.affected_rows === 1;
    }

    if (
      game_server_nodes_by_pk.lan_ip !== lanIP ||
      game_server_nodes_by_pk.public_ip !== publicIP ||
      (game_server_nodes_by_pk.build_id !== csBulid &&
        game_server_nodes_by_pk.update_status === null) ||
      (game_server_nodes_by_pk.csgo_build_id !== csgoBuildId &&
        game_server_nodes_by_pk.update_status === null) ||
      game_server_nodes_by_pk.supports_cpu_pinning !== supportsCpuPinning ||
      game_server_nodes_by_pk.supports_low_latency !== supportsLowLatency ||
      game_server_nodes_by_pk.gpu !== hasGpu ||
      !isJsonEqual(game_server_nodes_by_pk.gpu_info, gpuDevices) ||
      game_server_nodes_by_pk.cpu_sockets !== cpuInfo.sockets ||
      game_server_nodes_by_pk.cpu_cores_per_socket !== cpuInfo.coresPerSocket ||
      game_server_nodes_by_pk.cpu_threads_per_core !== cpuInfo.threadsPerCore ||
      !isJsonEqual(
        game_server_nodes_by_pk.cpu_governor_info,
        cpuGovernorInfo,
      ) ||
      game_server_nodes_by_pk.token ||
      !isJsonEqual(game_server_nodes_by_pk.cpu_frequency_info, cpuFrequencyInfo) ||
      !isJsonEqual(game_server_nodes_by_pk.cpu_warnings, cpuWarnings)
    ) {
      await this.hasura.mutation({
        update_game_server_nodes_by_pk: {
          __args: {
            pk_columns: {
              id: node,
            },
            _set: {
              lan_ip: lanIP,
              node_ip: nodeIP,
              public_ip: publicIP,
              supports_low_latency: supportsLowLatency,
              supports_cpu_pinning: supportsCpuPinning,
              ...(game_server_nodes_by_pk.update_status === null
                ? { build_id: csBulid }
                : {}),
              ...(game_server_nodes_by_pk.update_status === null
                ? { csgo_build_id: csgoBuildId }
                : {}),
              gpu: hasGpu,
              gpu_info: gpuDevices,
              cpu_sockets: cpuInfo.sockets,
              cpu_cores_per_socket: cpuInfo.coresPerSocket,
              cpu_threads_per_core: cpuInfo.threadsPerCore,
              cpu_governor_info: cpuGovernorInfo,
              cpu_frequency_info: cpuFrequencyInfo,
              cpu_warnings: cpuWarnings,
              disk_available_gb: rootDisk
                ? Number.isNaN(parseInt(rootDisk.available))
                  ? null
                  : Math.round(parseInt(rootDisk.available) / (1024 * 1024))
                : null,
              disk_used_percent: rootDisk
                ? Number.isNaN(parseInt(rootDisk.usedPercent))
                  ? null
                  : parseInt(rootDisk.usedPercent)
                : null,
              ...(game_server_nodes_by_pk.token ? { token: null } : {}),
            },
          },
          token: true,
        },
      });
    }

    if (
      game_server_nodes_by_pk.update_status === null &&
      csBulid &&
      game_server_nodes_by_pk.build_id !== csBulid
    ) {
      // Map assets and the gamedata validator both read this node's install,
      // so when a validation is queued the map-assets build is chained after it
      // (see ValidateGamedata) rather than run beside it on the same node.
      const validating = await this.queueGamedataValidation(node, csBulid);
      if (!validating) {
        await this.mapAssets.queueBuild(node, csBulid).catch((error) => {
          this.logger.warn(
            `[map-assets] unable to queue build ${csBulid}`,
            error,
          );
        });
      }
    }

    if (transitionedFromOffline && game_server_nodes_by_pk.build_id) {
      await this.updateCsServer(node);
    }

    const previousStatus = transitionedFromOffline ? "Offline" : storedStatus;

    return { previousStatus, label, offlineAt, transitionedFromOffline };
  }

  public async updateIdLabel(nodeId: string) {
    try {
      const node = await this.coreApi.readNode({
        name: nodeId,
      });

      await this.coreApi.patchNode({
        name: nodeId,
        body: [
          {
            op: "replace",
            path: "/metadata/labels",
            value: {
              ...node.metadata.labels,
              ...{
                "5stack-id": `${nodeId}`,
              },
            },
          },
        ],
      });
    } catch (error) {
      this.logger.warn("unable to patch node", error);
    }
  }

  public async updateCs() {
    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: {
            enabled: {
              _eq: true,
            },
          },
        },
        id: true,
        pin_build_id: true,
      },
    });

    for (const node of game_server_nodes) {
      await this.updateCsServer(node.id);
    }
  }

  public async updateCsServer(
    gameServerNodeId: string,
    force = false,
    game = "cs2",
  ) {
    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: {
          id: gameServerNodeId,
        },
        build_id: true,
        pinned_version: {
          build_id: true,
          downloads: true,
        },
        update_status: true,
        pin_plugin_version: true,
        pin_plugin_runtime: true,
      },
    });

    if (!game_server_nodes_by_pk) {
      this.logger.error(`Game server node not found`, gameServerNodeId);
      throw new Error("Game server not found");
    }

    await this.createVolumes(gameServerNodeId, game);

    if (game === "cs2" && !force) {
      const nodeBuildId = game_server_nodes_by_pk.build_id;
      const pinBuildId = game_server_nodes_by_pk.pinned_version?.build_id;

      if (pinBuildId) {
        if (nodeBuildId === pinBuildId) {
          this.logger.log(
            `CS2 is already up to date on node ${gameServerNodeId} (pinned build: ${pinBuildId})`,
          );
          return;
        }
      } else {
        const currentBuild = await this.getCurrentBuild();
        if (nodeBuildId === currentBuild) {
          this.logger.log(
            `CS2 is already up to date on node ${gameServerNodeId} (current build: ${currentBuild})`,
          );
          return;
        }
      }
    }

    this.logger.log(
      `Updating ${game === "csgo" ? "CSGO" : "CS2"} on node ${gameServerNodeId}`,
    );

    const jobName = GameServerNodeService.GET_UPDATE_JOB_NAME(
      gameServerNodeId,
      game,
    );
    const existingJob = await this.loggingService.getJob(jobName);

    if (existingJob && !GameServerNodeService.updateJobResult(existingJob)) {
      void this.monitorUpdateStatus(gameServerNodeId, game);
      return;
    }

    if (existingJob) {
      await this.batchApi
        .deleteNamespacedJob({
          name: jobName,
          namespace: this.namespace,
          propagationPolicy: "Background",
          gracePeriodSeconds: 0,
          body: { preconditions: { uid: existingJob.metadata.uid } },
        })
        .catch((error) => {
          if (error.code?.toString() !== "404") {
            throw error;
          }
        });
    }

    const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(".", "-");
    const gameId = game === "csgo" ? "740" : "730";
    const pinBuildId = game_server_nodes_by_pk.pinned_version?.build_id;

    const serverfilesVolumeName =
      game === "csgo"
        ? `serverfiles-csgo-${sanitizedGameServerNodeId}`
        : `serverfiles-${sanitizedGameServerNodeId}`;

    // /opt/scripts/update.sh ships in both runtime images; resolving the node's own
    // image keeps the update job on something already pulled onto that node.
    const updateImage =
      await this.pluginRuntimeService.resolveGameServerPluginImage(
        game_server_nodes_by_pk,
      );

    try {
      await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: {
            name: jobName,
          },
          spec: {
            template: {
              metadata: {
                labels: {
                  app: "update-cs-server",
                },
              },
              spec: {
                hostNetwork: true,
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
                    name: "update-cs-server",
                    image: updateImage,
                    command: ["/opt/scripts/update.sh"],
                    env: [
                      {
                        name: "GAME_ID",
                        value: gameId,
                      },
                      ...(game === "cs2" && pinBuildId
                        ? [
                            {
                              name: "BUILD_ID",
                              value: pinBuildId.toString(),
                            },
                            {
                              name: "BUILD_MANIFESTS",
                              value: JSON.stringify(
                                game_server_nodes_by_pk.pinned_version
                                  .downloads,
                              ),
                            },
                          ]
                        : []),
                      ...(game === "cs2" &&
                      pinBuildId &&
                      this.steamConfig.steamUser &&
                      this.steamConfig.steamPassword
                        ? [
                            {
                              name: "STEAM_USER",
                              value: this.steamConfig.steamUser,
                            },
                            {
                              name: "STEAM_PASSWORD",
                              value: this.steamConfig.steamPassword,
                            },
                          ]
                        : []),
                    ],
                    volumeMounts: [
                      {
                        name: `steamcmd-${sanitizedGameServerNodeId}`,
                        mountPath: "/serverdata/steamcmd",
                      },
                      {
                        name: serverfilesVolumeName,
                        mountPath: "/serverdata/serverfiles",
                      },
                      {
                        name: `demos-${sanitizedGameServerNodeId}`,
                        mountPath: "/opt/demos",
                      },
                    ],
                  },
                ],
                volumes: [
                  {
                    name: `steamcmd-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `steamcmd-${sanitizedGameServerNodeId}-claim`,
                    },
                  },
                  {
                    name: serverfilesVolumeName,
                    persistentVolumeClaim: {
                      claimName: `${serverfilesVolumeName}-claim`,
                    },
                  },
                  {
                    name: `demos-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `demos-${sanitizedGameServerNodeId}-claim`,
                    },
                  },
                ],
              },
            },
            backoffLimit: 1,
            ttlSecondsAfterFinished: GameServerNodeService.UPDATE_JOB_TTL_S,
          },
        },
      });

      await this.postgres.query(
        `UPDATE game_server_nodes
            SET update_status = 'Initializing', update_failed_at = NULL
          WHERE id = $1`,
        [gameServerNodeId],
      );

      void this.monitorUpdateStatus(gameServerNodeId, game);
    } catch (error) {
      this.logger.error(
        `Error creating job for ${gameServerNodeId}`,
        error?.response?.body?.message || error,
      );
      throw error;
    }
  }

  private async createVolumes(gameServerNodeId: string, game = "cs2") {
    if (game === "csgo") {
      await this.createVolume(
        gameServerNodeId,
        `/opt/5stack/serverfiles-csgo`,
        `serverfiles-csgo`,
        "75Gi",
      );
      return;
    }

    await this.createVolume(
      gameServerNodeId,
      `/opt/5stack/demos`,
      `demos`,
      "25Gi",
    );

    await this.createVolume(
      gameServerNodeId,
      `/opt/5stack/steamcmd`,
      `steamcmd`,
      "1Gi",
    );

    await this.createVolume(
      gameServerNodeId,
      `/opt/5stack/serverfiles`,
      `serverfiles`,
      "75Gi",
    );
  }

  /**
   * Supervises the update job for a node: waits for the pod, streams its logs
   * to derive a human-readable update_status, and re-attaches whenever the log
   * stream drops. The terminal decision (clear status / mark failed) is based
   * on the Job state, never on the log stream ending.
   */
  public async monitorUpdateStatus(
    gameServerNodeId: string,
    game = "cs2",
  ): Promise<void> {
    const monitorKey = `${gameServerNodeId}:${game}`;
    if (this.activeUpdateMonitors.has(monitorKey)) {
      return;
    }
    this.activeUpdateMonitors.add(monitorKey);

    const jobName = GameServerNodeService.GET_UPDATE_JOB_NAME(
      gameServerNodeId,
      game,
    );

    // progress lines arrive in bursts (every re-attach replays the log tail), so
    // only the latest status is written, one write at a time: an older write
    // can never land after a newer or terminal one
    let latestStatus: string | null | undefined;
    let writtenStatus: string | null | undefined;
    let flushing = false;
    let statusWrites = Promise.resolve();
    const writeStatus = (status: string | null) => {
      latestStatus = status;
      if (flushing || latestStatus === writtenStatus) {
        return statusWrites;
      }
      flushing = true;
      statusWrites = (async () => {
        await Promise.resolve();
        while (latestStatus !== writtenStatus) {
          const next = latestStatus;
          try {
            await this.setUpdateStatus(gameServerNodeId, next);
          } catch (error) {
            this.logger.warn(
              `[${gameServerNodeId}] unable to write update status`,
              error,
            );
          }
          writtenStatus = next;
        }
        flushing = false;
      })();
      return statusWrites;
    };

    try {
      while (true) {
        const job = await this.loggingService.getJob(jobName);
        const pod = await this.loggingService.getJobPod(jobName);

        if (!job && !pod) {
          await writeStatus(null);
          return;
        }

        const result = GameServerNodeService.updateJobResult(job);
        if (result) {
          await statusWrites;
          if (!GameServerNodeService.isUpdateResultRecorded(job)) {
            await this.recordUpdateResult(gameServerNodeId, game, job, result);
          }
          return;
        }

        if (pod?.status?.phase !== "Running") {
          await writeStatus("Initializing");
          await GameServerNodeService.sleep(5000);
          continue;
        }

        await this.streamUpdateProgress(pod, writeStatus);

        // the log stream dropped; loop to re-check the job and re-attach
        await GameServerNodeService.sleep(2500);
      }
    } catch (error) {
      // transient k8s error: leave update_status as-is, the periodic
      // reconciler will re-attach or clean up
      this.logger.warn(
        `[${gameServerNodeId}] unable to monitor update status`,
        error,
      );
    } finally {
      this.activeUpdateMonitors.delete(monitorKey);
    }
  }

  private async streamUpdateProgress(
    pod: V1Pod,
    writeStatus: (status: string | null) => Promise<void>,
  ): Promise<void> {
    let currentStep = "Updating";

    const handleLogLine = (log: string) => {
      const line = log.trim();
      if (!line) {
        return;
      }

      // unpinned: steamcmd app_update "Update state (0x61) downloading, progress: 12.34 (...)"
      const steamcmd = line.match(
        /Update state \(0x[0-9a-f]+\) ([^,]+), progress: ([0-9.]+)/,
      );
      if (steamcmd) {
        const type = steamcmd[1].trim();
        const percentage = Math.round(parseFloat(steamcmd[2]));
        void writeStatus(`${type} ${percentage}%`);
        return;
      }

      // pinned: "---Downloading Depot 2347770 (2/4) manifest ...---"
      const downloadHeader = line.match(
        /^---Downloading Depot \d+ \((\d+)\/(\d+)\)/,
      );
      if (downloadHeader) {
        currentStep = `Downloading depot ${downloadHeader[1]}/${downloadHeader[2]}`;
        void writeStatus(currentStep);
        return;
      }

      // pinned: "---Syncing Depot 2347770 (3/4, 5.2G) to ServerFiles---"
      const syncHeader = line.match(/^---Syncing Depot \d+ \((\d+)\/(\d+)/);
      if (syncHeader) {
        currentStep = `Installing depot ${syncHeader[1]}/${syncHeader[2]}`;
        void writeStatus(currentStep);
        return;
      }

      // pinned: "[depot 2347770] 1200 MB / 5230 MB (24%) downloaded (137 files)..."
      const depotProgress = line.match(
        /^\[depot \d+\] .*?\((\d+)%\) downloaded/,
      );
      if (depotProgress) {
        void writeStatus(`${currentStep} ${depotProgress[1]}%`);
        return;
      }

      // pinned, total not known yet: "[depot 2347770] 1200 MB downloaded so far (137 files)..."
      const depotProgressNoTotal = line.match(
        /^\[depot \d+\] (\d+) MB downloaded so far/,
      );
      if (depotProgressNoTotal) {
        void writeStatus(`${currentStep} (${depotProgressNoTotal[1]} MB)`);
        return;
      }

      // pinned: "[depot 2347770 sync] 45% (262,144,000, 118.2MB/s)"
      const syncProgress = line.match(/^\[depot \d+ sync\] (\d+)%/);
      if (syncProgress) {
        void writeStatus(`${currentStep} ${syncProgress[1]}%`);
        return;
      }

      if (line.startsWith("---Done Updating Server To Version")) {
        void writeStatus("Finishing");
      }
    };

    const stream = new PassThrough();

    await new Promise<void>((resolve) => {
      let settled = false;
      const idle = setTimeout(() => {
        stream.destroy();
      }, GameServerNodeService.UPDATE_LOG_IDLE_MS);
      const settle = () => {
        if (!settled) {
          settled = true;
          clearTimeout(idle);
          resolve();
        }
      };

      stream.on("data", (data: Buffer) => {
        idle.refresh();
        // a chunk may contain several concatenated JSON objects
        for (const piece of data.toString().split(/(?<=})\s*(?={")/)) {
          let log: string | undefined;
          try {
            ({ log } = JSON.parse(piece));
          } catch {
            continue;
          }
          if (log) {
            handleLogLine(log);
          }
        }
      });

      stream.on("end", settle);
      stream.on("close", settle);
      stream.on("error", settle);

      void this.loggingService.getLogsForPod(pod, stream).catch(() => {
        if (!stream.destroyed) {
          stream.destroy();
        }
        settle();
      });
    });
  }

  /**
   * Periodic safety net: attaches a monitor to any update job that is running,
   * or finished without its result recorded (e.g. after an API restart), and
   * clears a stale update_status when no such job is left. Failed jobs are
   * kept for their logs, so one whose result is recorded counts as gone.
   */
  public async reconcileUpdateStatuses(): Promise<void> {
    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: {
            enabled: {
              _eq: true,
            },
          },
        },
        id: true,
        update_status: true,
      },
    });

    for (const node of game_server_nodes) {
      try {
        let hasUpdateJob = false;

        for (const game of ["cs2", "csgo"]) {
          const jobName = GameServerNodeService.GET_UPDATE_JOB_NAME(
            node.id,
            game,
          );
          const job = await this.loggingService.getJob(jobName);
          const pod = await this.loggingService.getJobPod(jobName);

          const settled =
            GameServerNodeService.updateJobResult(job) &&
            GameServerNodeService.isUpdateResultRecorded(job);

          if ((job || pod) && !settled) {
            hasUpdateJob = true;
            void this.monitorUpdateStatus(node.id, game);
          }
        }

        if (
          !hasUpdateJob &&
          node.update_status !== null &&
          !this.activeUpdateMonitors.has(`${node.id}:cs2`) &&
          !this.activeUpdateMonitors.has(`${node.id}:csgo`)
        ) {
          this.logger.warn(
            `[${node.id}] clearing stale update status (${node.update_status})`,
          );
          await this.setUpdateStatus(node.id, null);
        }
      } catch (error) {
        this.logger.warn(
          `[${node.id}] unable to reconcile update status`,
          error,
        );
      }
    }
  }

  private async setUpdateStatus(
    gameServerNodeId: string,
    status: string | null,
  ): Promise<void> {
    await this.hasura.mutation({
      update_game_server_nodes_by_pk: {
        __args: {
          pk_columns: {
            id: gameServerNodeId,
          },
          _set: {
            update_status: status,
          },
        },
        update_status: true,
      },
    });
  }

  // the Failed condition, not status.failed: with backoffLimit 1 a first failed
  // pod leaves active at 0 for a moment before the retry pod is created
  public static updateJobResult(
    job?: V1Job | null,
  ): "Succeeded" | "Failed" | null {
    if (job?.status?.succeeded) {
      return "Succeeded";
    }
    if (
      job?.status?.conditions?.some(
        ({ type, status }) => type === "Failed" && status === "True",
      )
    ) {
      return "Failed";
    }
    return null;
  }

  public static isUpdateResultRecorded(job?: V1Job | null): boolean {
    return (
      job?.metadata?.annotations?.[
        GameServerNodeService.UPDATE_RESULT_RECORDED_ANNOTATION
      ] === "true"
    );
  }

  // update_status is one column shared by the cs2 and csgo jobs, so whether a
  // job's result was recorded lives on the job itself; the uid test makes the
  // claim fail on a retry job that has since reused the name
  private async claimUpdateResult(job: V1Job): Promise<boolean> {
    try {
      await this.batchApi.patchNamespacedJob({
        name: job.metadata.name,
        namespace: this.namespace,
        body: [
          { op: "test", path: "/metadata/uid", value: job.metadata.uid },
          {
            op: "add",
            path: "/metadata/annotations",
            value: {
              ...job.metadata.annotations,
              [GameServerNodeService.UPDATE_RESULT_RECORDED_ANNOTATION]: "true",
            },
          },
        ],
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `[${job.metadata.name}] unable to claim the update result`,
        error,
      );
      return false;
    }
  }

  private async recordUpdateResult(
    gameServerNodeId: string,
    game: string,
    job: V1Job,
    result: "Succeeded" | "Failed",
  ): Promise<void> {
    if (!(await this.claimUpdateResult(job))) {
      return;
    }

    if (result === "Succeeded") {
      await this.postgres.query(
        `UPDATE game_server_nodes
            SET update_status = NULL, update_failed_at = NULL
          WHERE id = $1`,
        [gameServerNodeId],
      );

      await this.batchApi
        .deleteNamespacedJob({
          name: job.metadata.name,
          namespace: this.namespace,
          propagationPolicy: "Background",
          body: { preconditions: { uid: job.metadata.uid } },
        })
        .catch((error) => {
          if (error.code?.toString() !== "404") {
            this.logger.warn(
              `[${gameServerNodeId}] unable to delete finished ${game} update job`,
              error,
            );
          }
        });
      return;
    }

    await this.postgres.query(
      `UPDATE game_server_nodes
          SET update_status = NULL, update_failed_at = now()
        WHERE id = $1`,
      [gameServerNodeId],
    );

    this.logger.warn(`[${gameServerNodeId}] ${game} update job failed`);
    void this.notifications.send("GameUpdate", {
      message: `The ${game === "csgo" ? "CSGO" : "CS2"} update failed on node ${gameServerNodeId}. Check the update logs for details.`,
      title: "Game Update Failed",
      role: "administrator",
    });
  }

  private static readonly GAMEDATA_LOCK_TTL_S = 60 * 60;

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public static GET_VALIDATE_GAMEDATA_JOB_NAME(
    buildId: number,
    branch = "public",
  ) {
    const sanitizedBranch = branch.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    return `validate-gamedata-${buildId}-${sanitizedBranch}`;
  }

  private async queueGamedataValidation(
    gameServerNodeId: string,
    buildId: number,
  ): Promise<boolean> {
    if (process.env.WEB_DOMAIN !== "5stack.gg") {
      return false;
    }

    const currentBuild = await this.getCurrentBuild();
    if (buildId !== currentBuild) {
      return false;
    }

    // A run in progress keeps the map-assets build chained behind it; one
    // left "running" past the lock's lifetime died with the api and chains
    // nothing, so the caller queues the map-assets build itself.
    const [existing] = await this.postgres.query<
      Array<{ status: string; in_flight: boolean }>
    >(
      `SELECT status,
              started_at > now() - make_interval(secs => $3) AS in_flight
         FROM public.gamedata_signature_validations
        WHERE build_id = $1
          AND branch = $2`,
      [buildId, "public", GameServerNodeService.GAMEDATA_LOCK_TTL_S],
    );

    if (existing) {
      return existing.status === "running" && existing.in_flight === true;
    }

    await this.validateGamedataQueue.add(
      "ValidateGamedata",
      {
        gameServerNodeId,
        buildId,
        buildMapAssets: true,
        trigger: "auto",
      },
      {
        jobId: `validate.${buildId}.auto`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    return true;
  }

  public async validateGamedata(
    gameServerNodeId: string,
    buildId: number,
    branch = "public",
    run: BuildRun = { trigger: "manual" },
  ): Promise<GamedataValidationOutcome | null> {
    const lockKey = GameServerNodeService.gamedataLockKey(buildId, branch);
    const acquired = await this.redis.set(
      lockKey,
      1,
      "EX",
      GameServerNodeService.GAMEDATA_LOCK_TTL_S,
      "NX",
    );
    if (acquired === null) {
      this.logger.warn(
        `[validate-gamedata] validation already running for build ${buildId} (${branch})`,
      );
      return null;
    }

    try {
      const [prior] = await this.postgres.query<
        Array<{ status: string; validated_at: Date | null }>
      >(
        `SELECT status, validated_at
           FROM public.gamedata_signature_validations
          WHERE build_id = $1
            AND branch = $2`,
        [buildId, branch],
      );

      await this.postgres.query(
        `INSERT INTO public.gamedata_signature_validations
           (build_id, branch, status, started_at, validated_at,
            game_server_node_id, trigger, requested_by_steam_id)
         VALUES ($1, $2, 'running', now(), NULL, $3, $4, $5)
         ON CONFLICT (build_id, branch) DO UPDATE
            SET status = 'running',
                started_at = now(),
                validated_at = NULL,
                game_server_node_id = EXCLUDED.game_server_node_id,
                trigger = EXCLUDED.trigger,
                requested_by_steam_id = EXCLUDED.requested_by_steam_id`,
        [
          buildId,
          branch,
          gameServerNodeId,
          run.trigger,
          run.requestedBy ?? null,
        ],
      );

      let result: GamedataValidationResult;
      try {
        result = (await this.runGamedataValidation(
          gameServerNodeId,
          buildId,
          branch,
        )) ?? {
          status: "error",
          broken: [],
          error: "the validation produced no result",
        };
      } catch (error) {
        result = {
          status: "error",
          broken: [],
          error: (error as Error)?.message ?? String(error),
        };
      }

      if (
        !GameServerNodeService.validatedAnything(result) &&
        (prior?.status === "pass" || prior?.status === "fail")
      ) {
        await this.postgres.query(
          `UPDATE public.gamedata_signature_validations
              SET status = $3,
                  validated_at = $4
            WHERE build_id = $1
              AND branch = $2`,
          [buildId, branch, prior.status, prior.validated_at],
        );

        return { result, previousBuildId: null, changes: null };
      }

      const [previous] = await this.postgres.query<
        Array<{ build_id: number; results: GamedataValidationResult }>
      >(
        `SELECT build_id, results
           FROM public.gamedata_signature_validations
          WHERE branch = $1
            AND build_id < $2
            AND status <> 'running'
            AND jsonb_typeof(results -> 'results') = 'array'
          ORDER BY build_id DESC
          LIMIT 1`,
        [branch, buildId],
      );

      const previousBuildId = previous?.build_id ?? null;
      const changes = GameServerNodeService.validatedAnything(result)
        ? GameServerNodeService.diffGamedata(result, previous?.results ?? null)
        : null;

      await this.postgres.query(
        `UPDATE public.gamedata_signature_validations
            SET status = $3,
                results = $4::jsonb,
                validated_at = now(),
                previous_build_id = $5,
                changes = $6::jsonb
          WHERE build_id = $1
            AND branch = $2`,
        [
          buildId,
          branch,
          result.status,
          JSON.stringify(result),
          previousBuildId,
          changes ? JSON.stringify(changes) : null,
        ],
      );

      return { result, previousBuildId, changes };
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async runGamedataValidation(
    gameServerNodeId: string,
    buildId: number,
    branch: string,
  ): Promise<GamedataValidationResult | null> {
    const jobName = GameServerNodeService.GET_VALIDATE_GAMEDATA_JOB_NAME(
      buildId,
      branch,
    );

    const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(".", "-");
    const serverfilesVolumeName = `serverfiles-${sanitizedGameServerNodeId}`;

    await this.batchApi
      .deleteNamespacedJob({
        name: jobName,
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
      body: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: jobName,
        },
        spec: {
          template: {
            metadata: {
              labels: {
                app: "validate-gamedata",
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
                  name: "validate-gamedata",
                  image: "ghcr.io/5stackgg/gamedata-validator:latest",
                  args: ["--build-id", buildId.toString(), "--runtime", "all"],
                  volumeMounts: [
                    {
                      name: serverfilesVolumeName,
                      mountPath: "/serverdata/serverfiles",
                      readOnly: true,
                    },
                  ],
                  resources: {
                    requests: {
                      cpu: "500m",
                      memory: "2Gi",
                    },
                    limits: {
                      memory: "6Gi",
                    },
                  },
                },
              ],
              volumes: [
                {
                  name: serverfilesVolumeName,
                  persistentVolumeClaim: {
                    claimName: `${serverfilesVolumeName}-claim`,
                    readOnly: true,
                  },
                },
              ],
            },
          },
          backoffLimit: 0,
          ttlSecondsAfterFinished: 60 * 60 * 24 * 7,
        },
      },
    });

    return await this.waitForGamedataValidation(jobName);
  }

  // The validator reports "error" both when it never ran (no pod, no logs)
  // and when it scanned everything but one set could not be verified, such
  // as the Swiftly gamedata fetch failing. Only the second has results worth
  // keeping or comparing against.
  public static validatedAnything(result: GamedataValidationResult): boolean {
    return Array.isArray(result.results);
  }

  public static gamedataErrorReason(
    result: GamedataValidationResult,
  ): string | null {
    if (result.error) {
      return result.error;
    }
    if (result.swiftly?.error) {
      return result.swiftly.error;
    }
    const unverified = Object.entries(result.statuses ?? {})
      .filter(([, status]) => status === "error")
      .map(([set]) => set);
    if (unverified.length) {
      return `could not verify ${unverified.join(", ")}`;
    }
    return null;
  }

  public static gamedataLockKey(buildId: number, branch = "public") {
    return `gamedata:validate:lock:${buildId}:${branch}`;
  }

  public static gamedataEntryKey(entry: {
    set: string;
    kind?: string | null;
    signature: string;
  }): string {
    return `${entry.set}\u0000${entry.kind ?? "signature"}\u0000${entry.signature}`;
  }

  // An entry counts as fixed only when the new run actually resolved it: one
  // the new run skipped (or no longer checks at all) is not evidence of a fix.
  public static diffGamedata(
    current: GamedataValidationResult,
    previous: GamedataValidationResult | null,
  ): GamedataValidationChanges {
    const skipped = current.skipped ?? [];
    const counts = {
      checked: Math.max((current.results?.length ?? 0) - skipped.length, 0),
      broken: current.broken?.length ?? 0,
      warnings: current.warnings?.length ?? 0,
      skipped: skipped.length,
    };

    if (!previous) {
      return {
        comparable: false,
        counts,
        newly_broken: [],
        fixed: [],
        new_warnings: [],
        cleared_warnings: [],
      };
    }

    const index = (entries?: Array<GamedataValidationEntry>) =>
      new Map(
        (entries ?? []).map((entry): [string, GamedataValidationEntry] => [
          GameServerNodeService.gamedataEntryKey(entry),
          entry,
        ]),
      );

    const currentBroken = index(current.broken);
    const previousBroken = index(previous.broken);
    const currentWarnings = index(current.warnings);
    const previousWarnings = index(previous.warnings);
    const currentResults = index(current.results);
    const previousResults = index(previous.results);
    const skippedKeys = new Set(
      skipped.map(GameServerNodeService.gamedataEntryKey),
    );

    const change = (
      entry: GamedataValidationEntry,
      before: GamedataValidationEntry | undefined,
      after: GamedataValidationEntry | undefined,
    ): GamedataChangeEntry => ({
      set: entry.set,
      kind: entry.kind ?? "signature",
      signature: entry.signature,
      runtimes: entry.runtimes ?? [],
      previous_count: before?.count ?? null,
      count: after?.count ?? null,
    });

    const resolvedNow = (key: string) =>
      !skippedKeys.has(key) &&
      (current.results ? currentResults.get(key)?.ok === true : true);

    return {
      comparable: true,
      counts,
      newly_broken: [...currentBroken]
        .filter(([key]) => !previousBroken.has(key))
        .map(([key, entry]) => change(entry, previousResults.get(key), entry)),
      fixed: [...previousBroken]
        .filter(([key]) => !currentBroken.has(key) && resolvedNow(key))
        .map(([key, entry]) => change(entry, entry, currentResults.get(key))),
      new_warnings: [...currentWarnings]
        .filter(([key]) => !previousWarnings.has(key))
        .map(([key, entry]) => change(entry, previousResults.get(key), entry)),
      cleared_warnings: [...previousWarnings]
        .filter(
          ([key]) =>
            !currentWarnings.has(key) &&
            !currentBroken.has(key) &&
            resolvedNow(key),
        )
        .map(([key, entry]) => change(entry, entry, currentResults.get(key))),
    };
  }

  public async gamedataValidationActive(
    buildId: number,
    branch = "public",
  ): Promise<boolean> {
    if (
      await this.redis.exists(
        GameServerNodeService.gamedataLockKey(buildId, branch),
      )
    ) {
      return true;
    }

    for (const jobId of [
      `validate.${buildId}.auto`,
      `validate.${buildId}.manual`,
    ]) {
      if (await this.validateGamedataQueue.getJob(jobId)) {
        return true;
      }
    }

    return false;
  }

  // Why a node cannot run a build job, or null when it can. Both jobs mount
  // the node's own install, so it has to be online and on the build itself.
  public static buildNodeIneligibility(
    node: BuildNodeCandidate,
    buildId: number,
  ): string | null {
    const name = node.label || node.id;

    if (!node.enabled) {
      return `${name} is disabled`;
    }
    if (node.gpu && !node.enabled_for_match_making) {
      return `${name} is a GPU-only node`;
    }
    if (node.status !== "Online") {
      return `${name} is ${node.status ?? "offline"}`;
    }
    if (node.update_status) {
      return `${name} is updating CS2`;
    }
    if (node.build_id !== buildId) {
      return `${name} is on build ${node.build_id ?? "unknown"}, not ${buildId}`;
    }

    return null;
  }

  public static pickBuildNode(
    nodes: Array<Pick<BuildNodeCandidate, "id">>,
    busy: Set<string>,
  ): string | null {
    const [picked] = [...nodes].sort(
      (a, b) =>
        Number(busy.has(a.id)) - Number(busy.has(b.id)) ||
        a.id.localeCompare(b.id),
    );

    return picked?.id ?? null;
  }

  public async resolveBuildNode(
    buildId: number,
    requested?: string | null,
  ): Promise<string> {
    const nodes = await this.postgres.query<Array<BuildNodeCandidate>>(
      `SELECT id, label, status, enabled, build_id, update_status, gpu,
              enabled_for_match_making
         FROM public.game_server_nodes`,
    );

    if (requested) {
      const node = nodes.find(({ id }) => id === requested);
      if (!node) {
        throw new Error(`Game server node ${requested} does not exist`);
      }

      const reason = GameServerNodeService.buildNodeIneligibility(
        node,
        buildId,
      );
      if (reason) {
        throw new Error(reason);
      }

      return node.id;
    }

    const eligible = nodes.filter(
      (node) => !GameServerNodeService.buildNodeIneligibility(node, buildId),
    );
    const picked = GameServerNodeService.pickBuildNode(
      eligible,
      await this.busyBuildNodes(),
    );

    if (!picked) {
      throw new Error(`No online game server node is on CS2 build ${buildId}`);
    }

    return picked;
  }

  private async busyBuildNodes(): Promise<Set<string>> {
    const rows = await this.postgres.query<
      Array<{ game_server_node_id: string }>
    >(
      `SELECT game_server_node_id
         FROM public.gamedata_signature_validations
        WHERE status = 'running'
          AND game_server_node_id IS NOT NULL
       UNION
       SELECT game_server_node_id
         FROM public.map_asset_builds
        WHERE status IN ('Pending', 'Building')
          AND game_server_node_id IS NOT NULL`,
    );

    return new Set(rows.map(({ game_server_node_id }) => game_server_node_id));
  }

  private async waitForGamedataValidation(
    jobName: string,
    timeoutMs = 30 * 60 * 1000,
  ): Promise<GamedataValidationResult | null> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const status = await this.loggingService.getJobStatus(jobName);
      if (status?.succeeded || status?.failed) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const pod = await this.loggingService.getJobPod(jobName);
    if (!pod?.metadata?.name) {
      this.logger.error(`[validate-gamedata] no pod found for ${jobName}`);
      return {
        status: "error",
        broken: [],
        error: "no pod was scheduled for the validation job",
      };
    }

    const reason = GameServerNodeService.podFailureReason(pod);

    let logs: string;
    try {
      logs = await this.coreApi.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.namespace,
      });
    } catch {
      this.logger.error(
        `[validate-gamedata] ${jobName} produced no logs${reason ? `: ${reason}` : ""}`,
      );
      return {
        status: "error",
        broken: [],
        error: reason ?? "could not read pod logs (container never started)",
      };
    }

    const result = GameServerNodeService.parseValidationResult(logs);
    if (!result) {
      return {
        status: "error",
        broken: [],
        error: reason ?? "no validation result was found in the pod logs",
      };
    }
    return result;
  }

  private static podFailureReason(pod: V1Pod): string | null {
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
        const detail = terminated.message ? `: ${terminated.message}` : "";
        return `${terminated.reason ?? "terminated"}${detail} (exit ${terminated.exitCode})`;
      }
    }

    if (pod.status?.phase === "Failed" && pod.status?.message) {
      return pod.status.message;
    }

    return null;
  }

  private static parseValidationResult(
    logs: string,
  ): GamedataValidationResult | null {
    const marker = "GAMEDATA_VALIDATION_RESULT ";
    for (const line of String(logs ?? "").split("\n")) {
      const index = line.indexOf(marker);
      if (index === -1) {
        continue;
      }
      try {
        return JSON.parse(line.slice(index + marker.length).trim());
      } catch {
        return null;
      }
    }
    return null;
  }

  private async createVolume(
    gameServerNodeId: string,
    path: string,
    name: string,
    size: string,
  ) {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const k8sApi = kc.makeApiClient(CoreV1Api);

    const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(".", "-");

    let existingPV;
    try {
      existingPV = await k8sApi.readPersistentVolume({
        name: `${name}-${sanitizedGameServerNodeId}`,
      });
    } catch (error) {
      if (error.code.toString() !== "404") {
        throw error;
      }
    }
    if (!existingPV) {
      try {
        await k8sApi.createPersistentVolume({
          body: {
            apiVersion: "v1",
            kind: "PersistentVolume",
            metadata: {
              name: `${name}-${sanitizedGameServerNodeId}`,
            },
            spec: {
              capacity: {
                storage: size,
              },
              volumeMode: "Filesystem",
              accessModes: ["ReadWriteOnce"],
              storageClassName: "local-storage",
              local: {
                path,
              },
              nodeAffinity: {
                required: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        {
                          key: "5stack-id",
                          operator: "In",
                          values: [gameServerNodeId],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        });
        this.logger.log(
          `Created PersistentVolume ${name}-${sanitizedGameServerNodeId}`,
        );
      } catch (error) {
        this.logger.error(
          `Error creating volume ${name}-${sanitizedGameServerNodeId}`,
          error?.response?.body?.message || error,
        );
        throw error;
      }
    }

    let existingClaim;
    try {
      existingClaim = await k8sApi.readNamespacedPersistentVolumeClaim({
        name: `${name}-${sanitizedGameServerNodeId}-claim`,
        namespace: this.namespace,
      });
    } catch (error) {
      if (error.code.toString() !== "404") {
        throw error;
      }
    }

    if (!existingClaim) {
      try {
        await k8sApi.createNamespacedPersistentVolumeClaim({
          namespace: this.namespace,
          body: {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: {
              name: `${name}-${sanitizedGameServerNodeId}-claim`,
              namespace: this.namespace,
            },
            spec: {
              volumeName: `${name}-${sanitizedGameServerNodeId}`,
              storageClassName: "local-storage",
              accessModes: ["ReadWriteOnce"],
              resources: {
                requests: {
                  storage: size,
                },
              },
            },
          },
        });
        this.logger.log(
          `Created PersistentVolumeClaim ${name}-${sanitizedGameServerNodeId}-claim`,
        );
      } catch (error) {
        this.logger.error(
          `Error creating claim ${name}-${sanitizedGameServerNodeId}`,
          error?.response?.body?.message || error,
        );
        throw error;
      }
    }
  }

  public async getNodeStats(node?: string) {
    const baseKey = GameServerNodeService.GET_NODE_STATS_KEY(node);
    const cpuStats = await this.redis.lrange(`${baseKey}:cpu`, 0, -1);

    const memoryStats = await this.redis.lrange(`${baseKey}:memory`, 0, -1);

    const disksStats = await this.redis.lrange(`${baseKey}:disks`, 0, -1);

    const networkStats = await this.redis.lrange(`${baseKey}:network`, 0, -1);

    const gpuStats = await this.redis.lrange(`${baseKey}:gpu`, 0, -1);

    return {
      node,
      cpu: cpuStats.map((stat) => JSON.parse(stat)).reverse(),
      memory: memoryStats.map((stat) => JSON.parse(stat)).reverse(),
      disks: disksStats.map((stat) => JSON.parse(stat)).reverse(),
      network: networkStats.map((stat) => JSON.parse(stat)).reverse(),
      gpu: gpuStats.map((stat) => JSON.parse(stat)).reverse(),
    };
  }

  public async getAllPodStats() {
    const nodes = await this.redis.smembers("stat-nodes");
    const services = await this.redis.smembers("stat-services");

    return (
      await Promise.all(
        nodes.map(async (node) => {
          return (
            await Promise.all(
              services.map(async (service) => {
                const cpuStats = await this.redis.lrange(
                  `pod-stats:${node}:${service}:cpu`,
                  0,
                  -1,
                );

                const memoryStats = await this.redis.lrange(
                  `pod-stats:${node}:${service}:memory`,
                  0,
                  -1,
                );

                if (cpuStats.length === 0 || memoryStats.length === 0) {
                  return;
                }

                return {
                  node: node,
                  name: service,
                  cpu: cpuStats.map((stat) => JSON.parse(stat)).reverse(),
                  memory: memoryStats.map((stat) => JSON.parse(stat)).reverse(),
                };
              }),
            )
          ).filter(Boolean);
        }),
      )
    ).flat();
  }

  public async getPodStats(nodeId: string, podName: string) {
    const baseKey = `pod-stats:${nodeId}:${podName}`;
    const cpu = await this.redis.get(`${baseKey}:cpu`);
    const memory = await this.redis.get(`${baseKey}:memory`);
    return { cpu, memory };
  }

  public async captureNodeStats(nodeId: string, stats: NodeStats) {
    const baseKey = GameServerNodeService.GET_NODE_STATS_KEY(nodeId);

    await this.redis.sadd("stat-nodes", nodeId);

    if (!stats?.metrics?.usage?.memory) {
      return;
    }

    await this.redis.lpush(
      `${baseKey}:cpu`,
      JSON.stringify({
        time: new Date(),
        total: stats.cpuCapacity,
        window: parseFloat(stats.metrics.window),
        used: this.convertCpuFromTypeToMilliCores(
          stats.metrics.usage.cpu,
        ).toString(),
      }),
    );

    await this.redis.lpush(
      `${baseKey}:memory`,
      JSON.stringify({
        time: new Date(),
        total: this.convertMemoryFromTypeToBytes(
          stats.memoryCapacity,
        ).toString(),
        used: this.convertMemoryFromTypeToBytes(
          stats.metrics.usage.memory,
        ).toString(),
      }),
    );

    if (stats.disks && stats.disks.length > 0) {
      await this.redis.lpush(
        `${baseKey}:disks`,
        JSON.stringify({
          time: new Date(),
          disks: stats.disks,
        }),
      );
    }

    if (stats.network && Object.keys(stats.network).length > 0) {
      await this.redis.lpush(
        `${baseKey}:network`,
        JSON.stringify({
          time: new Date(),
          nics: stats.network,
        }),
      );
    }

    if (stats.gpu?.devices && stats.gpu.devices.length > 0) {
      await this.redis.lpush(
        `${baseKey}:gpu`,
        JSON.stringify({
          time: new Date(),
          devices: stats.gpu.devices,
        }),
      );
    }

    await this.redis.ltrim(`${baseKey}:cpu`, 0, this.maxStatsHistory);
    await this.redis.ltrim(`${baseKey}:memory`, 0, this.maxStatsHistory);
    await this.redis.ltrim(`${baseKey}:network`, 0, this.maxStatsHistory);
    await this.redis.ltrim(`${baseKey}:disks`, 0, this.maxStatsHistory);
    await this.redis.ltrim(`${baseKey}:gpu`, 0, this.maxStatsHistory);

    await this.redis.expire(`${baseKey}:cpu`, this.maxOfflineStatsHistory);
    await this.redis.expire(`${baseKey}:memory`, this.maxOfflineStatsHistory);
    await this.redis.expire(`${baseKey}:network`, this.maxOfflineStatsHistory);
    await this.redis.expire(`${baseKey}:disks`, this.maxOfflineStatsHistory);
    await this.redis.expire(`${baseKey}:gpu`, this.maxOfflineStatsHistory);
  }

  public async capturePodStats(
    nodeId: string,
    cpuCount: number,
    memoryCapacity: string,
    pods: Array<PodStats>,
  ) {
    for (const pod of pods) {
      await this.redis.sadd("stat-services", pod.name);

      let totalCpu = BigInt(0);
      let totalMemory = BigInt(0);
      for (const container of pod.metrics.containers) {
        totalMemory += this.convertMemoryFromTypeToBytes(
          container.usage.memory,
        );

        let cpuUsage = this.convertCpuFromTypeToMilliCores(container.usage.cpu);

        totalCpu += cpuUsage;
      }
      const baseKey = `pod-stats:${nodeId}:${pod.name}`;

      await this.redis.lpush(
        `${baseKey}:memory`,
        JSON.stringify({
          time: new Date(),
          used: totalMemory.toString(),
          total: this.convertMemoryFromTypeToBytes(memoryCapacity).toString(),
        }),
      );

      await this.redis.lpush(
        `${baseKey}:cpu`,
        JSON.stringify({
          time: new Date(),
          used: totalCpu.toString(),
          total: cpuCount,
          window: parseFloat(pod.metrics.window),
        }),
      );

      await this.redis.ltrim(`${baseKey}:cpu`, 0, this.maxStatsHistory);
      await this.redis.ltrim(`${baseKey}:memory`, 0, this.maxStatsHistory);

      await this.redis.expire(`${baseKey}:cpu`, this.maxOfflineStatsHistory);
      await this.redis.expire(`${baseKey}:memory`, this.maxOfflineStatsHistory);
    }
  }

  private convertCpuFromTypeToMilliCores(cpu: string): bigint {
    if (cpu.endsWith("u")) {
      const uCores = BigInt(cpu.replace("u", ""));

      return uCores * BigInt(1000);
    }

    if (cpu.endsWith("n")) {
      return BigInt(cpu.replace("n", ""));
    }

    return BigInt(0);
  }

  private convertMemoryFromTypeToBytes(memory: string): bigint {
    if (memory.endsWith("Ki")) {
      return BigInt(memory.replace("Ki", "")) * BigInt(1024);
    }

    if (memory.endsWith("Mi")) {
      return BigInt(memory.replace("Mi", "")) * BigInt(1024) * BigInt(1024);
    }

    if (memory.endsWith("Gi")) {
      return (
        BigInt(memory.replace("Gi", "")) *
        BigInt(1024) *
        BigInt(1024) *
        BigInt(1024)
      );
    }

    this.logger.error(`Unknown memory type ${memory}`);

    return BigInt(0);
  }

  public async getCurrentBuild() {
    const { game_versions } = await this.hasura.query({
      game_versions: {
        __args: {
          where: {
            current: {
              _eq: true,
            },
          },
        },
        build_id: true,
      },
    });

    return game_versions.at(0)?.build_id;
  }

  public async updateDemoNetworkLimiters() {
    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: {
        id: true,
        demo_network_limiter: true,
      },
    });

    for (const node of game_server_nodes) {
      await this.updateDemoNetworkLimiterLabel(
        node.id,
        node.demo_network_limiter,
      );
    }
  }

  public async updateDemoNetworkLimiterLabel(nodeId: string, value?: number) {
    if (value === undefined) {
      value = await this.getGlobalDemoNetworkLimiter();
    }

    try {
      const node = await this.coreApi.readNode({
        name: nodeId,
      });

      await this.coreApi.patchNode({
        name: nodeId,
        body: [
          {
            op: "replace",
            path: "/metadata/labels",
            value: {
              ...node.metadata.labels,
              ...{
                "5stack-network-limiter": `${value}`,
              },
            },
          },
        ],
      });
    } catch (error) {
      if (error.code.toString() !== "404") {
        this.logger.warn("unable to patch node", error);
      }
    }
  }

  private async getGlobalDemoNetworkLimiter(): Promise<number | undefined> {
    const { settings } = await this.hasura.query({
      settings: {
        __args: { where: { name: { _eq: "demo_network_limiter" } } },
        value: true,
      },
    });

    return settings.at(0)?.value && parseInt(settings.at(0)?.value);
  }
}
