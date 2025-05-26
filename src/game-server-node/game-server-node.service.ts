import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { e_game_server_node_statuses_enum } from "../../generated";
import {
  KubeConfig,
  CoreV1Api,
  PatchUtils,
  BatchV1Api,
} from "@kubernetes/client-node";
import { GameServersConfig } from "src/configs/types/GameServersConfig";
import { ConfigService } from "@nestjs/config";
import { NodeStats } from "./jobs/NodeStats";
import { PodStats } from "./jobs/PodStats";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { Redis } from "ioredis";
import { LoggingServiceService } from "./logging-service/logging-service.service";
import { PassThrough } from "stream";

@Injectable()
export class GameServerNodeService {
  private redis: Redis;
  private readonly namespace: string;
  private maxStatsHistory: number = 60 * 3;
  private gameServerConfig: GameServersConfig;

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
        supports_low_latency: true,
        supports_cpu_pinning: true,
      },
    });

    if (!game_server_nodes_by_pk) {
      await this.create(undefined, node, status);
      return;
    }

    if (
      game_server_nodes_by_pk.lan_ip !== lanIP ||
      game_server_nodes_by_pk.public_ip !== publicIP ||
      game_server_nodes_by_pk.status !== status ||
      game_server_nodes_by_pk.build_id !== csBulid ||
      game_server_nodes_by_pk.supports_cpu_pinning !== supportsCpuPinning ||
      game_server_nodes_by_pk.supports_low_latency !== supportsLowLatency ||
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
              lan_ip: lanIP,
              node_ip: nodeIP,
              public_ip: publicIP,
              supports_low_latency: supportsLowLatency,
              supports_cpu_pinning: supportsCpuPinning,
              ...(csBulid ? { build_id: csBulid } : {}),
              ...(game_server_nodes_by_pk.token ? { token: null } : {}),
            },
          },
          token: true,
        },
      });
    }

    if (status === "Online" && game_server_nodes_by_pk.status !== status) {
      await this.updateCsServer(node);
    }
  }

  public async updateIdLabel(nodeId: string) {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const core = kc.makeApiClient(CoreV1Api);

    try {
      // Fetch the current node
      const { body: node } = await core.readNode(nodeId);

      await core.patchNode(
        nodeId,
        [
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { "Content-type": PatchUtils.PATCH_FORMAT_JSON_PATCH } },
      );
    } catch (error) {
      console.warn("unable to patch node", error);
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
      },
    });

    if (!game_server_nodes_by_pk || !game_server_nodes_by_pk.build_id) {
      this.logger.error(`Game server node not found`, gameServerNodeId);
      throw new Error("Game server not found");
    }

    if (!force) {
      const { settings_by_pk } = await this.hasura.query({
        settings_by_pk: {
          __args: {
            name: "cs_version",
          },
          value: true,
        },
      });

      if (settings_by_pk?.value) {
        const currentBuild: {
          buildid: string;
        } = JSON.parse(settings_by_pk.value);

        if (
          currentBuild.buildid === game_server_nodes_by_pk?.build_id.toString()
        ) {
          this.logger.log(
            `CS2 is already up to date on node ${gameServerNodeId}`,
          );
          return;
        }
      }
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

    this.logger.log(`Updating CS2 on node ${gameServerNodeId}`);

    const pod = await this.getUpdateJobPod(gameServerNodeId);

    if (pod) {
      await this.moitorUpdateStatus(gameServerNodeId);
      return;
    }

    const kc = new KubeConfig();
    kc.loadFromDefault();

    const batchV1Api = kc.makeApiClient(BatchV1Api);

    try {
      await batchV1Api.createNamespacedJob(this.namespace, {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: `update-cs-server-${gameServerNodeId}`,
        },
        spec: {
          template: {
            metadata: {
              labels: {
                app: "update-cs-server",
              },
            },
            spec: {
              nodeName: gameServerNodeId,
              restartPolicy: "Never",
              containers: [
                {
                  name: "update-cs-server",
                  image: "ghcr.io/5stackgg/game-server:latest",
                  command: ["/opt/scripts/update.sh"],
                  volumeMounts: [
                    {
                      name: `steamcmd-${gameServerNodeId}`,
                      mountPath: "/serverdata/steamcmd",
                    },
                    {
                      name: `serverfiles-${gameServerNodeId}`,
                      mountPath: "/serverdata/serverfiles",
                    },
                    {
                      name: `demos-${gameServerNodeId}`,
                      mountPath: "/opt/demos",
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: `steamcmd-${gameServerNodeId}`,
                  persistentVolumeClaim: {
                    claimName: `steamcmd-${gameServerNodeId}-claim`,
                  },
                },
                {
                  name: `serverfiles-${gameServerNodeId}`,
                  persistentVolumeClaim: {
                    claimName: `serverfiles-${gameServerNodeId}-claim`,
                  },
                },
                {
                  name: `demos-${gameServerNodeId}`,
                  persistentVolumeClaim: {
                    claimName: `demos-${gameServerNodeId}-claim`,
                  },
                },
              ],
            },
          },
          backoffLimit: 1,
          ttlSecondsAfterFinished: 30,
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

  public async moitorUpdateStatus(gameServerNodeId: string, attempts = 0) {
    try {
      const pod = await this.getUpdateJobPod(gameServerNodeId);

      if (!pod) {
        console.warn("unable to find update job pod");
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
      this.loggingService.getLogsForPod(pod, stream);

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
        console.warn("unable to monitor update status", error);
      }
      if (attempts > 0) {
        setTimeout(() => {
          void this.moitorUpdateStatus(gameServerNodeId, attempts - 1);
        }, 5000);
      }
    }
  }

  private async getUpdateJobPod(gameServerNodeId: string) {
    try {
      const kc = new KubeConfig();
      kc.loadFromDefault();

      const batchV1Api = kc.makeApiClient(BatchV1Api);

      const { body: job } = await batchV1Api.readNamespacedJob(
        `update-cs-server-${gameServerNodeId}`,
        this.namespace,
      );

      const coreV1Api = kc.makeApiClient(CoreV1Api);

      const { body: pods } = await coreV1Api.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${job.metadata.name}`,
      );

      return pods.items.at(0);
    } catch (error) {
      if (error?.response?.statusCode !== 404) {
        throw error;
      }
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

    let existingPV;
    try {
      existingPV = await k8sApi.readPersistentVolume(
        `${name}-${gameServerNodeId}`,
      );
    } catch (error) {
      if (error?.response?.statusCode !== 404) {
        throw error;
      }
    }
    if (!existingPV) {
      try {
        await k8sApi.createPersistentVolume({
          apiVersion: "v1",
          kind: "PersistentVolume",
          metadata: {
            name: `${name}-${gameServerNodeId}`,
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
        });
        this.logger.log(`Created PersistentVolume ${name}-${gameServerNodeId}`);
      } catch (error) {
        this.logger.error(
          `Error creating volume ${name}-${gameServerNodeId}`,
          error?.response?.body?.message || error,
        );
        throw error;
      }
    }

    let existingClaim;
    try {
      existingClaim = await k8sApi.readNamespacedPersistentVolumeClaim(
        `${name}-${gameServerNodeId}-claim`,
        this.namespace,
      );
    } catch (error) {
      if (error?.response?.statusCode !== 404) {
        throw error;
      }
    }

    if (!existingClaim) {
      try {
        await k8sApi.createNamespacedPersistentVolumeClaim(this.namespace, {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name: `${name}-${gameServerNodeId}-claim`,
            namespace: this.namespace,
          },
          spec: {
            volumeName: `${name}-${gameServerNodeId}`,
            storageClassName: "local-storage",
            accessModes: ["ReadWriteOnce"],
            resources: {
              requests: {
                storage: size,
              },
            },
          },
        });
        this.logger.log(
          `Created PersistentVolumeClaim ${name}-${gameServerNodeId}-claim`,
        );
      } catch (error) {
        this.logger.error(
          `Error creating claim ${name}-${gameServerNodeId}`,
          error?.response?.body?.message || error,
        );
        throw error;
      }
    }
  }

  public async getNodeStats() {
    const nodes = await this.redis.smembers("stat-nodes");

    return await Promise.all(
      nodes.map(async (node) => {
        const cpuStats = await this.redis.lrange(
          `node-stats:${node}:cpu`,
          0,
          -1,
        );
        const memoryStats = await this.redis.lrange(
          `node-stats:${node}:memory`,
          0,
          -1,
        );

        return {
          node,
          cpu: cpuStats.map((stat) => JSON.parse(stat)).reverse(),
          memory: memoryStats.map((stat) => JSON.parse(stat)).reverse(),
        };
      }),
    );
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
    const baseKey = `node-stats:${nodeId}`;

    await this.redis.sadd("stat-nodes", nodeId);

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

    await this.redis.ltrim(`${baseKey}:memory`, 0, this.maxStatsHistory);
    await this.redis.ltrim(`${baseKey}:cpu`, 0, this.maxStatsHistory);

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
      const oneHour = 3600;
      const baseKey = `pod-stats:${nodeId}:${pod.name}`;

      await this.redis.lpush(
        `${baseKey}:memory`,
        JSON.stringify({
          time: new Date(),
          used: totalMemory.toString(),
          total: this.convertMemoryFromTypeToBytes(memoryCapacity).toString(),
        }),
      );

      await this.redis.expire(`${baseKey}:memory`, oneHour);

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
}
