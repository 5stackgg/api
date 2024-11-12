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
import { Request, Response } from "express";
import { LoggingServiceService } from "./logging-service/logging-service.service";

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
    protected readonly loggingService: LoggingServiceService,
    protected readonly gameServerNodeService: GameServerNodeService,
    @InjectQueue(GameServerQueues.GameUpdate) private queue: Queue,
  ) {
    this.appConfig = this.config.get<AppConfig>("app");
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");

    this.namespace = this.gameServerConfig.namespace;
  }

  @HasuraAction()
  public async updateCs(data: { game_server_node_id: string }) {
    await this.gameServerNodeService.updateCs(data.game_server_node_id);

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
        mkdir -p /opt/5stack/custom-plugins
    `;

    response.setHeader("Content-Length", Buffer.byteLength(scriptContent));
    response.write(scriptContent);
    response.end();
  }

  @HasuraAction()
  public async getNodeStats() {
    return await this.gameServerNodeService.getNodeStats();
  }

  @HasuraAction()
  public async getServiceStats() {
    return await this.gameServerNodeService.getAllPodStats();
  }

  @HasuraAction()
  public async setupGameServer(data: { user: User }) {
    const gameServer = await this.gameServerNodeService.create(
      await this.tailscale.getAuthKey(),
    );

    return {
      link: `curl -o- ${this.appConfig.apiDomain}/game-server-node/script/${gameServer.id}.sh?token=${gameServer.token} | bash`,
    };
  }

  @Get("/ping/:serverId")
  public async ping(@Req() request: Request) {
    const map = request.query.map;
    const serverId = request.params.serverId;


    const { servers_by_pk: server } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: serverId,
        },
        connected: true,
        is_dedicated: true,
        current_match: {
          current_match_map_id: true,
          match_maps: {
            id: true,
            map: {
              name: true,
            },
          },
        },
      },
    });

    if(!server) {
      throw Error("server not found");
    }

    if(server.current_match && !server.is_dedicated) {
      const currentMap = server.current_match?.match_maps.find((match_map) => {
        return match_map.id === server.current_match.current_match_map_id;
      });

      if(map !== currentMap?.map.name) {
        this.logger.warn(`server is still loading the map`);
        return;
      }
    }
    
    if(!server.connected) {
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
    }
    
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
