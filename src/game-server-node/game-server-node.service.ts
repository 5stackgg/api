import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { e_game_server_node_statuses_enum } from "../../generated";
import { KubeConfig, CoreV1Api, BatchV1Api } from "@kubernetes/client-node";
import { GameServersConfig } from "src/configs/types/GameServersConfig";
import { ConfigService } from "@nestjs/config";
import { NodeStats } from "./interfaces/NodeStats";
import { PodStats } from "./interfaces/PodStats";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { Redis } from "ioredis";
import { LoggingServiceService } from "./logging-service/logging-service.service";
import { PassThrough } from "stream";
import { SteamConfig } from "src/configs/types/SteamConfig";
import { isJsonEqual } from "@utilities/isJsonEqual";

@Injectable()
export class GameServerNodeService {
  private redis: Redis;
  private steamConfig: SteamConfig;
  private gameServerConfig: GameServersConfig;

  private readonly namespace: string;

  private coreApi: CoreV1Api;
  private batchApi: BatchV1Api;

  // keep 1.5 hours of stats; with a ping every 30 seconds, that's 3,600 / 30 = 120 per hour, so 1.5 * 120 = 180 entries.
  private maxOfflineStatsHistory = 60 * 90;
  private maxStatsHistory: number = 180 - 1;

  constructor(
    protected readonly logger: Logger,
    protected readonly config: ConfigService,
    protected readonly hasura: HasuraService,
    redisManager: RedisManagerService,
    protected readonly loggingService: LoggingServiceService,
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

  public static GET_UPDATE_JOB_NAME(gameServerNodeId: string) {
    return `update-cs-server-${gameServerNodeId.replaceAll(".", "-")}`;
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
    nvidiaGPU: boolean,
    status: e_game_server_node_statuses_enum,
  ) {
    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: {
          id: node,
        },
        token: true,
        status: true,
        lan_ip: true,
        node_ip: true,
        build_id: true,
        public_ip: true,
        gpu: true,
        cpu_sockets: true,
        cpu_cores_per_socket: true,
        cpu_threads_per_core: true,
        supports_low_latency: true,
        supports_cpu_pinning: true,
        cpu_governor_info: true,
        update_status: true,
      },
    });

    if (csBulid && !game_server_nodes_by_pk?.build_id) {
      await this.createVolumes(node);
      return;
    }

    if (game_server_nodes_by_pk?.status === "NotAcceptingNewMatches") {
      status = "NotAcceptingNewMatches";
    }

    if (!game_server_nodes_by_pk) {
      await this.create(undefined, node, status);
      return;
    }

    if (
      game_server_nodes_by_pk.lan_ip !== lanIP ||
      game_server_nodes_by_pk.public_ip !== publicIP ||
      game_server_nodes_by_pk.status !== status ||
      (game_server_nodes_by_pk.build_id !== csBulid &&
        game_server_nodes_by_pk.update_status === null) ||
      game_server_nodes_by_pk.supports_cpu_pinning !== supportsCpuPinning ||
      game_server_nodes_by_pk.supports_low_latency !== supportsLowLatency ||
      game_server_nodes_by_pk.gpu !== nvidiaGPU ||
      game_server_nodes_by_pk.cpu_sockets !== cpuInfo.sockets ||
      game_server_nodes_by_pk.cpu_cores_per_socket !== cpuInfo.coresPerSocket ||
      game_server_nodes_by_pk.cpu_threads_per_core !== cpuInfo.threadsPerCore ||
      !isJsonEqual(
        game_server_nodes_by_pk.cpu_governor_info,
        cpuGovernorInfo,
      ) ||
      game_server_nodes_by_pk.token
    ) {
      await this.hasura.mutation({
        update_game_server_nodes_by_pk: {
          __args: {
            pk_columns: {
              id: node,
            },
            _set: {
              status,
              offline_at: null,
              lan_ip: lanIP,
              node_ip: nodeIP,
              public_ip: publicIP,
              supports_low_latency: supportsLowLatency,
              supports_cpu_pinning: supportsCpuPinning,
              ...(game_server_nodes_by_pk.update_status === null
                ? { build_id: csBulid }
                : {}),
              gpu: nvidiaGPU,
              cpu_sockets: cpuInfo.sockets,
              cpu_cores_per_socket: cpuInfo.coresPerSocket,
              cpu_threads_per_core: cpuInfo.threadsPerCore,
              cpu_governor_info: cpuGovernorInfo,
              ...(game_server_nodes_by_pk.token ? { token: null } : {}),
            },
          },
          token: true,
        },
      });
    }

    if (
      status === "Online" &&
      game_server_nodes_by_pk.build_id &&
      game_server_nodes_by_pk.status !== status
    ) {
      await this.updateCsServer(node);
    }
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

  public async updateCsServer(gameServerNodeId: string, force = false) {
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

    const nodeBuildId = game_server_nodes_by_pk.build_id;
    const pinBuildId = game_server_nodes_by_pk.pinned_version?.build_id;

    if (!force) {
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

    await this.createVolumes(gameServerNodeId);

    this.logger.log(`Updating CS2 on node ${gameServerNodeId}`);

    const pod = await this.loggingService.getJobPod(
      GameServerNodeService.GET_UPDATE_JOB_NAME(gameServerNodeId),
    );

    if (pod) {
      if (game_server_nodes_by_pk.update_status === null) {
        await this.hasura.mutation({
          update_game_server_nodes_by_pk: {
            __args: {
              pk_columns: {
                id: gameServerNodeId,
              },
              _set: {
                update_status: "Initializing",
              },
            },
            update_status: true,
          },
        });
      }

      await this.moitorUpdateStatus(gameServerNodeId);
      return;
    }

    const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(".", "-");

    try {
      await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: {
            name: `update-cs-server-${sanitizedGameServerNodeId}`,
          },
          spec: {
            template: {
              metadata: {
                labels: {
                  app: "update-cs-server",
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
                    name: "update-cs-server",
                    image: "ghcr.io/5stackgg/game-server:latest",
                    command: ["/opt/scripts/update.sh"],
                    env: [
                      ...(pinBuildId
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
                      ...(pinBuildId &&
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
                        name: `serverfiles-${sanitizedGameServerNodeId}`,
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
                    name: `serverfiles-${sanitizedGameServerNodeId}`,
                    persistentVolumeClaim: {
                      claimName: `serverfiles-${sanitizedGameServerNodeId}-claim`,
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

      await this.hasura.mutation({
        update_game_server_nodes_by_pk: {
          __args: {
            pk_columns: {
              id: gameServerNodeId,
            },
            _set: {
              update_status: "Initializing",
            },
          },
          update_status: true,
        },
      });

      setTimeout(() => {
        void this.moitorUpdateStatus(gameServerNodeId, 3);
      }, 5000);
    } catch (error) {
      this.logger.error(
        `Error creating job for ${gameServerNodeId}`,
        error?.response?.body?.message || error,
      );
      throw error;
    }
  }

  private async createVolumes(gameServerNodeId: string) {
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

  public async moitorUpdateStatus(gameServerNodeId: string, attempts = 0) {
    try {
      const pod = await this.loggingService.getJobPod(
        GameServerNodeService.GET_UPDATE_JOB_NAME(gameServerNodeId),
      );

      if (!pod) {
        this.logger.warn(`[${gameServerNodeId}] unable to find update job pod`);
        await this.hasura.mutation({
          update_game_server_nodes_by_pk: {
            __args: {
              pk_columns: {
                id: gameServerNodeId,
              },
              _set: {
                update_status: null,
              },
            },
            update_status: true,
          },
        });

        return;
      }

      const kc = new KubeConfig();
      kc.loadFromDefault();

      let currentType: string;
      let currentPercentage = 0;

      const { game_server_nodes_by_pk } = await this.hasura.query({
        game_server_nodes_by_pk: {
          __args: {
            id: gameServerNodeId,
          },
          update_status: true,
        },
      });

      let _currentStatus = game_server_nodes_by_pk?.update_status;

      if (_currentStatus) {
        const match = _currentStatus.match(/([^0-9]+) ([0-9.]+)/);
        if (match) {
          currentType = match[1].trim();
          currentPercentage = parseFloat(match[2]);
        }
      }

      const stream = new PassThrough();
      void this.loggingService.getLogsForPod(pod, stream);

      stream.on("data", async (data) => {
        const { log } = JSON.parse(data.toString());

        if (!log) {
          return;
        }

        const typeMatch = log.match(/Update state \(0x[0-9a-f]+\) ([^,]+)/);
        const type = typeMatch ? typeMatch[1] : null;
        let percentage = log.match(/progress: (\d+\.\d+)/)?.[1];

        if (!percentage) {
          return;
        }

        percentage = Math.round(parseFloat(percentage) * 100) / 100;

        if (type === currentType && percentage < currentPercentage + 5) {
          return;
        }

        currentType = type;
        currentPercentage = percentage;

        await this.hasura.mutation({
          update_game_server_nodes_by_pk: {
            __args: {
              pk_columns: {
                id: gameServerNodeId,
              },
              _set: {
                update_status: `${type} ${percentage}%`,
              },
            },
            update_status: true,
          },
        });
      });

      stream.on("end", async () => {
        await this.hasura.mutation({
          update_game_server_nodes_by_pk: {
            __args: {
              pk_columns: {
                id: gameServerNodeId,
              },
              _set: {
                update_status: null,
              },
            },
            update_status: true,
          },
        });
      });
    } catch (error) {
      if (process.env.DEV) {
        this.logger.warn("unable to monitor update status", error);
      }
      if (attempts > 0) {
        setTimeout(() => {
          void this.moitorUpdateStatus(gameServerNodeId, attempts - 1);
        }, 5000);
        return;
      }

      await this.hasura.mutation({
        update_game_server_nodes_by_pk: {
          __args: {
            pk_columns: {
              id: gameServerNodeId,
            },
            _set: {
              update_status: null,
            },
          },
          update_status: true,
        },
      });
    }
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

    return {
      node,
      cpu: cpuStats.map((stat) => JSON.parse(stat)).reverse(),
      memory: memoryStats.map((stat) => JSON.parse(stat)).reverse(),
      disks: disksStats.map((stat) => JSON.parse(stat)).reverse(),
      network: networkStats.map((stat) => JSON.parse(stat)).reverse(),
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

    await this.redis.ltrim(`${baseKey}:cpu`, 0, this.maxStatsHistory);
    await this.redis.ltrim(`${baseKey}:memory`, 0, this.maxStatsHistory);
    await this.redis.ltrim(`${baseKey}:network`, 0, this.maxStatsHistory);
    await this.redis.ltrim(`${baseKey}:disks`, 0, this.maxStatsHistory);

    await this.redis.expire(`${baseKey}:cpu`, this.maxOfflineStatsHistory);
    await this.redis.expire(`${baseKey}:memory`, this.maxOfflineStatsHistory);
    await this.redis.expire(`${baseKey}:network`, this.maxOfflineStatsHistory);
    await this.redis.expire(`${baseKey}:disks`, this.maxOfflineStatsHistory);
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
