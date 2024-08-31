import { WorkerHost } from "@nestjs/bullmq";
import { GameServerQueues } from "../enums/GameServerQueues";
import { Job } from "bullmq";
import { HasuraService } from "../../hasura/hasura.service";
import { UseQueue } from "../../utilities/QueueProcessors";

@UseQueue("GameServerNode", GameServerQueues.NodeOffline)
export class MarkGameServerOffline extends WorkerHost {
  constructor(protected readonly hasura: HasuraService) {
    super();
  }

  async process(
    job: Job<{
      serverId: string;
    }>,
  ): Promise<void> {
    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: {
            id: job.data.serverId,
          },
          _set: {
            connected: false,
          },
        },
        __typename: true,
      },
    });
  }
}
