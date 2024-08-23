import { Processor, WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Job } from "bullmq";
import { HasuraService } from "../../hasura/hasura.service";

@Processor(GameServerQueues.NodeOffline)
export class MarkGameServerNodeOffline extends WorkerHost {
  constructor(protected readonly hasura: HasuraService) {
    super();
  }

  async process(
    job: Job<{
      node: string;
    }>,
  ): Promise<void> {
    await this.hasura.mutation({
      update_game_server_nodes_by_pk: {
        __args: {
          pk_columns: {
            id: job.data.node,
          },
          _set: {
            status: "Offline",
          },
        },
      },
    });
  }
}
