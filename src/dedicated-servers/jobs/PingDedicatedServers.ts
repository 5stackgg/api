import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";
import { DedicatedServerQueues } from "../enums/DedicatedServerQueues";
import { DedicatedServersService } from "../dedicated-servers.service";

@UseQueue("DedicatedServers", DedicatedServerQueues.PingDedicatedServers)
export class PingDedicatedServers extends WorkerHost {
  constructor(
    private readonly hasura: HasuraService,
    private readonly dedicatedServersService: DedicatedServersService,
  ) {
    super();
  }
  async process(): Promise<void> {
    const { servers } = await this.hasura.query({
      servers: {
        __args: {
          where: {
            enabled: {
              _eq: true,
            },
            type: {
              _neq: "Ranked",
            },
            game_server_node_id: {
              _is_null: false,
            },
          },
        },
        id: true,
      },
    });

    for (const server of servers) {
      await this.dedicatedServersService.pingDedicatedServer(server.id);
    }
  }
}
