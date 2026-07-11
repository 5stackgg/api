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
            type: {
              _neq: "Ranked",
            },
            is_dedicated: {
              _eq: true,
            },
            // Node-managed servers have their deployment torn down when
            // disabled, so a disabled one is genuinely offline. External
            // servers keep running on their own host, so still ping disabled
            // ones to reflect their real online state.
            _or: [
              { enabled: { _eq: true } },
              { game_server_node_id: { _is_null: true } },
            ],
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
          server.game_server_node &&
          server.game_server_node.status !== "Online"
        ) {
          await this.hasura.mutation({
            update_servers_by_pk: {
              __args: {
                pk_columns: { id: server.id },
                _set: { connected: false },
              },
              __typename: true,
            },
          });
          return;
        }
        await this.dedicatedServersService.pingDedicatedServer(server.id);
      }),
    );
  }
}
