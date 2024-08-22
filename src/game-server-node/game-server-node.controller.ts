import { User } from "../auth/types/User";
import { Controller } from "@nestjs/common";
import { HasuraAction } from "../hasura/hasura.controller";
import { TailscaleService } from "../tailscale/tailscale.service";
import { HasuraService } from "../hasura/hasura.service";

@Controller("game-server-node")
export class GameServerNodeController {
  constructor(
    protected readonly hasura: HasuraService,
    protected readonly tailscale: TailscaleService,
  ) {}

  @HasuraAction()
  public async setupGameServer(data: { user: User }) {
    const { insert_server_nodes_one } = await this.hasura.mutation({
      insert_server_nodes_one: {
        __args: {
          object: {
            start_port_range: 20000,
            end_port_range: 20200,
            region: "east",
            status: "disconnected",
            enabled: true,
          },
        },
        id: true,
      },
    });

    const script = `
      curl -fsSL https://tailscale.com/install.sh | sh
      tailscale up --authkey=${await this.tailscale.getAuthKey()}
      curl -sfL https://get.k3s.io | K3S_URL=https://${process.env.TAILSCALE_NODE_IP}:6443 K3S_TOKEN=${process.env.K3S_TOKEN} sh -s - --node-name ${insert_server_nodes_one.id}
    `;

    return {
      id: insert_server_nodes_one.id,
      script,
    };
  }
}
