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
        game_server_node: {
          status: true,
        },
      },
    });

    await Promise.all(
      servers.map(async (server) => {
        if (
          !server.game_server_node ||
          server.game_server_node.status !== "Online"
        ) {
          await this.hasura.mutation({
            update_servers_by_pk: {
              __args: {
                pk_columns: { id: server.id },
                _set: { connected: false },
              },
            },
          });
          return;
        }
        await this.dedicatedServersService.pingDedicatedServer(server.id);
      }),
    );
  }
}
