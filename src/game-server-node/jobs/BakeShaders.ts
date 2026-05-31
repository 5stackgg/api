import { InjectQueue, WorkerHost } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { Logger } from "@nestjs/common";
import { UseQueue } from "../../utilities/QueueProcessors";
import { GameServerQueues } from "../enums/GameServerQueues";
import { HasuraService } from "../../hasura/hasura.service";
import {
  GameStreamerService,
  NodeBusyError,
} from "../../matches/game-streamer/game-streamer.service";

type BakeShadersData = {
  gameServerNodeId: string;
  attempt?: number;
};

@UseQueue("GameServerNode", GameServerQueues.BakeShaders)
export class BakeShaders extends WorkerHost {
  constructor(
    protected readonly logger: Logger,
    protected readonly hasura: HasuraService,
    protected readonly gameStreamer: GameStreamerService,
    @InjectQueue(GameServerQueues.BakeShaders)
    protected readonly bakeQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<BakeShadersData>): Promise<void> {
    const { gameServerNodeId } = job.data;
    const attempt = job.data.attempt ?? 0;

    if (attempt > 60) {
      this.logger.warn(
        `[bake ${gameServerNodeId}] giving up after ${attempt} requeues`,
      );
      return;
    }

    const { game_server_nodes_by_pk: node } = await this.hasura.query({
      game_server_nodes_by_pk: {
        __args: { id: gameServerNodeId },
        id: true,
        gpu: true,
      },
    });

    if (!node || !node.gpu) {
      return;
    }

    try {
      await this.gameStreamer.bakeShaders(gameServerNodeId);
    } catch (error) {
      if (error instanceof NodeBusyError) {
        this.logger.log(
          `[bake ${gameServerNodeId}] node busy — requeueing until idle`,
        );
        await this.requeue(job.data);
        return;
      }
      throw error;
    }
  }

  private async requeue(data: BakeShadersData): Promise<void> {
    const attempt = (data.attempt ?? 0) + 1;
    await this.bakeQueue.add(
      BakeShaders.name,
      { ...data, attempt },
      {
        jobId: `bake.${data.gameServerNodeId}.${attempt}`,
        delay: 60 * 1000,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}
