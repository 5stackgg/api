import { User } from "../auth/types/User";
import { Controller, Get, Logger, Req, Res } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { GameServerNodeService } from "./game-server-node.service";
import { TailscaleService } from "../tailscale/tailscale.service";
import { HasuraService } from "../hasura/hasura.service";
import { InjectQueue } from "@nestjs/bullmq";
import { GameServerQueues } from "./enums/GameServerQueues";
import { Queue } from "bullmq";
import { MarkGameServerOffline } from "./jobs/MarkGameServerOffline";
import { ConfigService } from "@nestjs/config";
import { GameServersConfig } from "../configs/types/GameServersConfig";
import { AppConfig } from "../configs/types/AppConfig";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { SteamConfig } from "src/configs/types/SteamConfig";
import { Request, Response } from "express";

@Controller("game-server-node")
export class GameServerNodeController {
  private readonly namespace: string;
  private gameServerConfig: GameServersConfig;
  private appConfig: AppConfig;

  constructor(
    protected readonly logger: Logger,
    protected readonly config: ConfigService,
    protected readonly hasura: HasuraService,
    protected readonly tailscale: TailscaleService,
    protected readonly gameServerNodeService: GameServerNodeService,
    @InjectQueue(GameServerQueues.GameUpdate) private queue: Queue,
  ) {
    this.appConfig = this.config.get<AppConfig>("app");
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");

    this.namespace = this.gameServerConfig.namespace;
  }

  @HasuraAction()
  public async updateCs(data: { gameServerId: string }) {
    if (data.gameServerId) {
      const gameServerId = data.gameServerId;

      const { game_server_nodes_by_pk } = await this.hasura.query({
        game_server_nodes_by_pk: {
          __args: {
            id: gameServerId,
          },
          token: true,
        },
      });

      if (!game_server_nodes_by_pk || game_server_nodes_by_pk.token === null) {
        throw new Error("Game server not found");
      }

      await this.updateCsServer(data.gameServerId);
      return {
        success: true,
      };
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

    return {
      success: true,
    };
  }

  private async updateCsServer(nodeId: string) {
    this.logger.log(`Updating CS2 on node ${nodeId}`);

    const kc = new KubeConfig();
    kc.loadFromDefault();

    const batchV1Api = kc.makeApiClient(BatchV1Api);

    await batchV1Api.createNamespacedJob(this.namespace, {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: `update-cs-server-${nodeId}`,
      },
      spec: {
        template: {
          metadata: {
            labels: {
              app: "update-cs-server",
            },
          },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "update-cs-server",
                image: "ghcr.io/5stackgg/game-server:latest",
                command: ["/opt/scripts/update.sh"],
                env: [
                  {
                    name: "USERNAME",
                    value: this.config.get<SteamConfig>("steam").serverAccount,
                  },
                  {
                    name: "PASSWRD",
                    value:
                      this.config.get<SteamConfig>("steam")
                        .serverAccountPassword,
                  },
                ],
                volumeMounts: [
                  {
                    name: "steamcmd-5stack",
                    mountPath: "/serverdata/steamcmd",
                  },
                  {
                    name: "serverfiles-5stack",
                    mountPath: "/serverdata/serverfiles",
                  },
                  {
                    name: "demos-5stack",
                    mountPath: "/opt/demos",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: `steamcmd-${nodeId}`,
                persistentVolumeClaim: {
                  claimName: `steamcmd-${nodeId}-claim`,
                },
              },
              {
                name: `serverfiles-${nodeId}`,
                persistentVolumeClaim: {
                  claimName: `serverfiles-${nodeId}-claim`,
                },
              },
              {
                name: `demos-${nodeId}`,
                persistentVolumeClaim: {
                  claimName: `demos-${nodeId}-claim`,
                },
              },
            ],
          },
        },
        backoffLimit: 1,
        ttlSecondsAfterFinished: 30,
      },
    });
  }

  @Get("/script/:gameServerId.sh")
  public async script(@Req() request: Request, @Res() response: Response) {
    const gameServerId = request.params.gameServerId;

    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: {
          id: gameServerId,
        },
        token: true,
      },
    });

    if (!game_server_nodes_by_pk || game_server_nodes_by_pk.token === null) {
      throw new Error("Game server not found");
    }

    response.setHeader("Content-Type", "text/plain");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${gameServerId}.sh"`,
    );
    // Set the content length to avoid download issues
    const scriptContent = `
        sudo -i
        
        sudo bash << EOF

        echo "Connecting to secure network";
      
        curl -fsSL https://tailscale.com/install.sh | sh

        echo "Installing k3s";
        curl -sfL https://get.k3s.io | K3S_URL=https://${process.env.TAILSCALE_NODE_IP}:6443 K3S_TOKEN=${process.env.K3S_TOKEN} sh -s - --node-name ${gameServerId} --vpn-auth="name=tailscale,joinKey=${game_server_nodes_by_pk.token}";

        mkdir -p /opt/5stack/demos
        mkdir -p /opt/5stack/steamcmd
        mkdir -p /opt/5stack/serverfiles
    `;

    response.setHeader("Content-Length", Buffer.byteLength(scriptContent));
    response.write(scriptContent);
    response.end();
  }

  private async createVolume(
    nodeId: string,
    path: string,
    name: string,
    size: string,
  ) {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const k8sApi = kc.makeApiClient(CoreV1Api);

    try {
      await k8sApi.createPersistentVolume({
        apiVersion: "v1",
        kind: "PersistentVolume",
        metadata: {
          name: `${name}-${nodeId}`,
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
                      values: [nodeId],
                    },
                  ],
                },
              ],
            },
          },
        },
      });
    } catch (error) {
      this.logger.error(
        `Error creating volume ${name}-${nodeId}`,
        error?.response?.body?.message || error,
      );
      throw error;
    }

    try {
      await k8sApi.createNamespacedPersistentVolumeClaim(this.namespace, {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: `${name}-${nodeId}-claim`,
          namespace: this.namespace,
        },
        spec: {
          volumeName: `${name}-${nodeId}`,
          storageClassName: "local-storage",
          accessModes: ["ReadWriteOnce"],
          resources: {
            requests: {
              storage: size,
            },
          },
        },
      });
    } catch (error) {
      this.logger.error(
        `Error creating volume claim ${name}-${nodeId}`,
        error?.response?.body?.message || error,
      );
      throw error;
    }
  }

  @HasuraAction()
  public async setupGameServer(data: { user: User }) {
    const gameServer = await this.gameServerNodeService.create(
      await this.tailscale.getAuthKey(),
    );

    const gameServerId = gameServer.id;

    await this.createVolume(
      gameServerId,
      `/opt/5stack/demos`,
      `demos-${gameServerId}`,
      "25Gi",
    );
    await this.createVolume(
      gameServerId,
      `/opt/5stack/steamcmd`,
      `steamcmd-${gameServerId}`,
      "1Gi",
    );
    await this.createVolume(
      gameServerId,
      `/opt/5stack/serverfiles`,
      `serverfiles-${gameServerId}`,
      "75Gi",
    );

    return {
      link: `curl -o- ${this.appConfig.apiDomain}/game-server-node/script/${gameServerId}.sh?token=${gameServer.token} | bash`,
    };
  }

  @Get("/ping/:serverId")
  public async ping(@Req() request: Request) {
    const serverId = request.params.serverId;
    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: {
            id: serverId,
          },
          _set: {
            connected: true,
          },
        },
        __typename: true,
      },
    });

    await this.queue.remove(`server-offline:${serverId}`);

    await this.queue.add(
      MarkGameServerOffline.name,
      {
        serverId,
      },
      {
        delay: 30 * 1000,
        attempts: 1,
        removeOnFail: false,
        removeOnComplete: true,
        jobId: `server-offline:${serverId}`,
      },
    );
  }
}
