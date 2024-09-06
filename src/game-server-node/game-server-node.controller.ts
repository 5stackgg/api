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
import vdf from "vdf-parser";

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
  public async updateCs(data: { gameServerNodeId: string }) {
    if (data.gameServerNodeId) {
      const gameServerNodeId = data.gameServerNodeId;

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

      await this.updateCsServer(data.gameServerNodeId);

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
              affinity: {
                nodeAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: {
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
              restartPolicy: "Never",
              containers: [
                {
                  name: "update-cs-server",
                  image: "ghcr.io/5stackgg/game-server:latest",
                  command: ["/opt/scripts/update.sh"],
                  env: [
                    {
                      name: "USERNAME",
                      value:
                        this.config.get<SteamConfig>("steam").serverAccount,
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

  @Get("/script/:gameServerNodeId.sh")
  public async script(@Req() request: Request, @Res() response: Response) {
    const gameServerNodeId = request.params.gameServerNodeId;

    const { game_server_nodes_by_pk } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: {
          id: gameServerNodeId,
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
      `attachment; filename="${gameServerNodeId}.sh"`,
    );
    // Set the content length to avoid download issues
    const scriptContent = `
        sudo -i
        
        sudo bash << EOF

        echo "Connecting to secure network";
      
        curl -fsSL https://tailscale.com/install.sh | sh

        if [ -d "/etc/sysctl.d" ]; then
          echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
          echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
          sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
        else
          echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.conf
          echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.conf
          sudo sysctl -p /etc/sysctl.conf
        fi

        echo "Installing k3s";
        curl -sfL https://get.k3s.io | K3S_URL=https://${process.env.TAILSCALE_NODE_IP}:6443 K3S_TOKEN=${process.env.K3S_TOKEN} sh -s - --node-name ${gameServerNodeId} --vpn-auth="name=tailscale,joinKey=${game_server_nodes_by_pk.token}";

        mkdir -p /opt/5stack/demos
        mkdir -p /opt/5stack/steamcmd
        mkdir -p /opt/5stack/serverfiles
    `;

    response.setHeader("Content-Length", Buffer.byteLength(scriptContent));
    response.write(scriptContent);
    response.end();
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
    } catch (error) {
      this.logger.error(
        `Error creating volume ${name}-${gameServerNodeId}`,
        error?.response?.body?.message || error,
      );
      throw error;
    }

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
    } catch (error) {
      this.logger.error(
        `Error creating volume claim ${name}-${gameServerNodeId}`,
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

    const gameServerNodeId = gameServer.id;

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

    return {
      link: `curl -o- ${this.appConfig.apiDomain}/game-server-node/script/${gameServerNodeId}.sh?token=${gameServer.token} | bash`,
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

  @HasuraAction()
  public async getCsVersion(data: { gameServerNodeId: string }) {
    try {
      const version = await this.runOnNode(
        data.gameServerNodeId,
        "cat /serverdata/serverfiles/steamapps/appmanifest_730.acf",
      );
      const parsed = vdf.parse(version) as {
        AppState?: {
          buildid?: number;
        };
      };

      const buildId = parsed?.AppState?.buildid;

      if (!buildId) {
        return;
      }

      await this.hasura.mutation({
        update_game_server_nodes_by_pk: {
          __args: {
            pk_columns: {
              id: data.gameServerNodeId,
            },
            _set: {
              build_id: buildId,
            },
          },
          __typename: true,
        },
      });
    } catch (error) {
      this.logger.error(
        `Error getting CS2 version for ${data.gameServerNodeId}`,
        error?.response?.body?.message || error,
      );
      throw error;
    }
  }

  private async runOnNode(gameServerNodeId: string, command: string) {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const batchV1Api = kc.makeApiClient(BatchV1Api);

    const jobName = `get-cs-version-${gameServerNodeId}`;

    await batchV1Api.createNamespacedJob(this.namespace, {
      metadata: {
        name: jobName,
        namespace: this.namespace,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 15,
        template: {
          spec: {
            restartPolicy: "Never",
            nodeName: gameServerNodeId,
            containers: [
              {
                image: "docker.io/library/alpine",
                name: "command",
                stdin: true,
                stdinOnce: false,
                tty: false,
                command: ["/bin/sh", "-c", command],
                volumeMounts: [
                  {
                    name: `serverfiles-${gameServerNodeId}`,
                    mountPath: "/serverdata/serverfiles",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: `serverfiles-${gameServerNodeId}`,
                persistentVolumeClaim: {
                  claimName: `serverfiles-${gameServerNodeId}-claim`,
                },
              },
            ],
          },
        },
      },
    });

    let status = "active";
    while (status === "active") {
      const jobStatus = await this.getJobStatus(jobName);
      const failed = jobStatus?.status?.failed;
      const success = jobStatus?.status?.succeeded;
      if (success || failed) {
        status = failed ? "failed" : "success";
      }
      await new Promise((resolve) => {
        setTimeout(() => {
          resolve(true);
        }, 1000);
      });
    }

    const coreV1Api = kc.makeApiClient(CoreV1Api);
    const pods = await coreV1Api.listNamespacedPod(
      this.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `job-name=${jobName}`,
    );

    if (pods.body.items.length > 0) {
      const podName = pods.body.items[0].metadata.name;
      const { body } = await coreV1Api.readNamespacedPodLog(
        podName,
        this.namespace,
      );
      return body;
    }
  }

  private async getJobStatus(job: string) {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const batchV1Api = kc.makeApiClient(BatchV1Api);

    const { body } = await batchV1Api.readNamespacedJobStatus(
      job,
      this.namespace,
    );

    return body;
  }
}
