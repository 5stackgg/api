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
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
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
  public async updateCs(data: { gameServerNodeId: string }) {
    await this.gameServerNodeService.updateCs(data.gameServerNodeId);

    return {
      success: true,
    };
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
}
