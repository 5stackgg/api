import { User } from "../auth/types/User";
import { Controller, Get, Req } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { GameServerNodeService } from "./game-server-node.service";
import { TailscaleService } from "../tailscale/tailscale.service";
import { Request } from "express";
import { HasuraService } from "../hasura/hasura.service";
import { InjectQueue } from "@nestjs/bullmq";
import { GameServerQueues } from "./enums/GameServerQueues";
import { Queue } from "bullmq";
import { MarkGameServerOffline } from "./jobs/MarkGameServerOffline";

@Controller("game-server-node")
export class GameServerNodeController {
  constructor(
    protected readonly hasura: HasuraService,
    protected readonly tailscale: TailscaleService,
    protected readonly gameServerNodeService: GameServerNodeService,
    @InjectQueue(GameServerQueues.GameUpdate) private queue: Queue,
  ) {}

  @HasuraAction()
  public async setupGameServer(data: { user: User }) {
    const gameServer = await this.gameServerNodeService.create();

    const script = `
      curl -fsSL https://tailscale.com/install.sh | sh
      tailscale up --authkey=${await this.tailscale.getAuthKey()}
      curl -sfL https://get.k3s.io | K3S_URL=https://${process.env.TAILSCALE_NODE_IP}:6443 K3S_TOKEN=${process.env.K3S_TOKEN} sh -s - --node-name ${gameServer.id}
    `;

    return {
      id: gameServer.id,
      script,
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
