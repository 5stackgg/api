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
@Injectable()
export class GameServerNodeService {
  private redis: Redis; 
  private readonly namespace: string;
  private gameServerConfig: GameServersConfig;

  constructor(
    protected readonly logger: Logger,
    protected readonly config: ConfigService,
    protected readonly hasura: HasuraService,
    redisManager: RedisManagerService,
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
    const { insert_game_server_nodes_one } = await this.hasura.mutation({
      insert_game_server_nodes_one: {
        __args: {
          object: {
            id: node,
            token,
            status,
            region: "Lan",
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
    lanIP: string,
    publicIP: string,
    csBulid: number,
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
        build_id: true,
        public_ip: true,
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
              public_ip: publicIP,
              ...(csBulid ? { build_id: csBulid } : {}),
              ...(game_server_nodes_by_pk.token ? { token: null } : {}),
            },
          },
          token: true,
        },
      });
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

  public async updateCs(gameServerNodeId?: string) {
    if (gameServerNodeId) {
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

      const { game_server_nodes_by_pk } = await this.hasura.query({
        game_server_nodes_by_pk: {
          __args: {
            id: gameServerNodeId,
          },
          id: true,
        },
      });

      if (!game_server_nodes_by_pk) {
        throw new Error("Game server not found");
      }

      await this.updateCsServer(gameServerNodeId);
      return;
    }

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

  private async updateCsServer(gameServerNodeId: string) {
    this.logger.log(`Updating CS2 on node ${gameServerNodeId}`);

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
    } catch (error) {
      this.logger.error(
        `Error creating job for ${gameServerNodeId}`,
        error?.response?.body?.message || error,
      );
      throw error;
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
    const keys = await this.redis.keys('node-stats:*:cpu');
    const nodeIds = keys.map(key => key.split(':')[1]);
    
    const nodes = await Promise.all(nodeIds.map(async (nodeId) => {
      const cpuStats = await this.redis.lrange(`node-stats:${nodeId}:cpu`, 0, -1);
      const memoryStats = await this.redis.lrange(`node-stats:${nodeId}:memory`, 0, -1);

      return {
        node: nodeId,
        cpu: cpuStats.map(stat => JSON.parse(stat)).reverse(),
        memory: memoryStats.map(stat => JSON.parse(stat)).reverse()
      };
    }));

    return nodes;
  }
  
  public async getPodStats(nodeId: string, podName: string) {
    const baseKey = `pod-stats:${nodeId}:${podName}`;
    const cpu = await this.redis.get(`${baseKey}:cpu`);
    const memory = await this.redis.get(`${baseKey}:memory`);
    return { cpu, memory };
  }

  public async captureNodeStats(nodeId: string, stats: NodeStats) {
    const baseKey = `node-stats:${nodeId}`;

    await this.redis.lpush(
      `${baseKey}:memory`,
      JSON.stringify({
        time: new Date(),
        total: (BigInt(stats.memoryCapacity.replace('Ki', '')) * BigInt(1024)).toString(),
        available: (BigInt(stats.memoryAllocatable.replace('Ki', '')) * BigInt(1024)).toString(),
        used: (BigInt(stats.metrics.usage.memory.replace('Ki', '')) * BigInt(1024)).toString(),
      })
    );
    
    await this.redis.ltrim(`${baseKey}:memory`, 0, 3600);
    await this.redis.ltrim(`${baseKey}:cpu`, 0, 3600);

    await this.redis.lpush(
      `${baseKey}:cpu`,
      JSON.stringify({
        time: new Date(),
        total: parseInt(stats.cpuCapacity),
        available: parseInt(stats.cpuAllocatable),
        used: BigInt(stats.metrics.usage.cpu.replace("n", "")).toString(),
      })
    );
  }   

  public async capturePodStats(nodeId: string, pods: Array<PodStats>) {
    for(const pod of pods) {
      let totalCpu = BigInt(0);
      let totalMemory = BigInt(0);
      for(const container of pod.metrics.containers) {
        totalMemory += BigInt(container.usage.memory.replace('Ki', '')) * BigInt(1024);
        totalCpu += container.usage.cpu ? BigInt(container.usage.cpu.replace('n', '')) : BigInt(0);
      }
      const oneHour = 3600;
      const baseKey = `pod-stats:${nodeId}:${pod.name}`;

      await this.redis.lpush(
        `${baseKey}:memory`,
        JSON.stringify({
          time: new Date(),
          value: totalMemory.toString(),
        })
      );
      
      await this.redis.expire(`${baseKey}:memory`, oneHour);

      await this.redis.lpush(
        `${baseKey}:cpu`, 
        JSON.stringify({
          time: new Date(),
          value: totalCpu.toString(),
        })
      );

      await this.redis.ltrim(`${baseKey}:cpu`, 0, 3600);
      await this.redis.ltrim(`${baseKey}:memory`, 0, 3600);
    }
  }
}
