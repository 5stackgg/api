import { User } from "../auth/types/User";
import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { GameServerNodeService } from "./game-server-node.service";
import { TailscaleService } from "../tailscale/tailscale.service";

@Controller("game-server-node")
export class GameServerNodeController {
  constructor(
    protected readonly tailscale: TailscaleService,
    protected readonly gameServerNodeService: GameServerNodeService,
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
}
