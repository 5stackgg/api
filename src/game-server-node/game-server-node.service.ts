import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { e_game_server_node_statuses_enum } from "../../generated";
import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
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

export type GamedataValidationRuntime = PluginRuntime;

export type GamedataValidationEntry = {
  set: string;
  runtimes?: Array<GamedataValidationRuntime>;
  signature: string;
  kind?: "signature" | "vtable" | "patch";
  count: number | null;
  skipped?: boolean;
  reason?: string;
};

export type GamedataValidationResult = {
  build_id?: number | null;
  status: "pass" | "fail" | "error";
  broken: Array<GamedataValidationEntry>;
  warnings?: Array<GamedataValidationEntry>;
  skipped?: Array<GamedataValidationEntry>;
  results?: Array<Record<string, unknown>>;
  error?: string;
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
      !isJsonEqual(game_server_nodes_by_pk.cpu_frequency_info, cpuFrequencyInfo)
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
      await this.queueGamedataValidation(node, csBulid);
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
    const pod = await this.loggingService.getJobPod(jobName);

    if (pod) {
      // an update job is already running: just make sure it's monitored
      void this.monitorUpdateStatus(gameServerNodeId, game);
      return;
    }

    const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(".", "-");
    const gameId = game === "csgo" ? "740" : "730";
    const pinBuildId = game_server_nodes_by_pk.pinned_version?.build_id;

    const serverfilesVolumeName =
      game === "csgo"
        ? `serverfiles-csgo-${sanitizedGameServerNodeId}`
        : `serverfiles-${sanitizedGameServerNodeId}`;

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
                    image: "ghcr.io/5stackgg/game-server:latest",
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
            ttlSecondsAfterFinished: 30,
          },
        },
      });

      await this.setUpdateStatus(gameServerNodeId, "Initializing");

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

    let lastWrittenStatus: string | null | undefined;
    const writeStatus = async (status: string | null) => {
      if (status === lastWrittenStatus) {
        return;
      }
      lastWrittenStatus = status;
      await this.setUpdateStatus(gameServerNodeId, status);
    };

    try {
      while (true) {
        const job = await this.loggingService.getJob(jobName);
        const pod = await this.loggingService.getJobPod(jobName);

        if (!job && !pod) {
          await writeStatus(null);
          return;
        }

        if (job?.status?.succeeded) {
          await writeStatus(null);
          return;
        }

        if (job?.status?.failed && !job?.status?.active) {
          this.logger.warn(`[${gameServerNodeId}] ${game} update job failed`);
          await writeStatus(null);
          void this.notifications.send("GameUpdate", {
            message: `The ${game === "csgo" ? "CSGO" : "CS2"} update failed on node ${gameServerNodeId}. Check the update logs for details.`,
            title: "Game Update Failed",
            role: "administrator",
          });
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
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      stream.on("data", (data: Buffer) => {
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
   * Periodic safety net: attaches a monitor to any update job that is running
   * without one (e.g. after an API restart), and clears stale update_status
   * values whose job no longer exists.
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

          if (job || pod) {
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
  ) {
    if (process.env.WEB_DOMAIN !== "5stack.gg") {
      return;
    }

    const currentBuild = await this.getCurrentBuild();
    if (buildId !== currentBuild) {
      return;
    }

    const { gamedata_signature_validations } = await this.hasura.query({
      gamedata_signature_validations: {
        __args: {
          where: {
            build_id: { _eq: buildId },
            branch: { _eq: "public" },
          },
          limit: 1,
        },
        id: true,
      },
    });

    if (gamedata_signature_validations.length > 0) {
      return;
    }

    await this.validateGamedataQueue.add(
      "ValidateGamedata",
      {
        gameServerNodeId,
        buildId,
      },
      {
        jobId: `validate.${buildId}.auto`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  public async validateGamedata(
    gameServerNodeId: string,
    buildId: number,
    branch = "public",
  ): Promise<GamedataValidationResult | null> {
    const jobName = GameServerNodeService.GET_VALIDATE_GAMEDATA_JOB_NAME(
      buildId,
      branch,
    );

    const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(".", "-");
    const serverfilesVolumeName = `serverfiles-${sanitizedGameServerNodeId}`;

    // without --runtime the validator defaults to "all" and fetches SwiftlyS2 gamedata,
    // so a GitHub blip fails validation on installs that never load SwiftlyS2
    const { game_server_nodes_by_pk: node } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: { id: gameServerNodeId },
        pin_plugin_runtime: true,
      },
    });

    const runtime = await this.pluginRuntimeService.resolvePluginRuntime(node);

    const lockKey = `gamedata:validate:lock:${buildId}:${branch}`;
    const acquired = await this.redis.set(lockKey, 1, "EX", 60 * 60, "NX");
    if (acquired === null) {
      this.logger.warn(
        `[validate-gamedata] validation already running for build ${buildId} (${branch})`,
      );
      return null;
    }

    try {
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
                containers: [
                  {
                    name: "validate-gamedata",
                    image: "ghcr.io/5stackgg/gamedata-validator:latest",
                    args: [
                      "--build-id",
                      buildId.toString(),
                      "--runtime",
                      runtime,
                    ],
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

      const result = await this.waitForGamedataValidation(jobName);

      await this.hasura.mutation({
        delete_gamedata_signature_validations: {
          __args: {
            where: {
              build_id: { _eq: buildId },
              branch: { _eq: branch },
            },
          },
          affected_rows: true,
        },
      });

      await this.hasura.mutation({
        insert_gamedata_signature_validations_one: {
          __args: {
            object: {
              build_id: buildId,
              branch,
              status: result?.status ?? "error",
              results: result ?? null,
            },
          },
          id: true,
        },
      });

      return result;
    } finally {
      await this.redis.del(lockKey);
    }
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
