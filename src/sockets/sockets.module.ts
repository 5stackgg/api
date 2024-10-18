import { Module } from "@nestjs/common";
import { SocketsGateway } from "./sockets.gateway";
import { loggerFactory } from "../utilities/LoggerFactory";
import { RedisModule } from "src/redis/redis.module";
import { MatchMakingModule } from "src/match-making/match-making.module";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { SocketQueues } from "./enums/SocketQueues";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { CheckSocketNodeJob } from "./jobs/CheckSocketNodeJob";
import { Queue } from "bullmq";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";

@Module({
  exports: [],
  imports: [
    RedisModule,
    MatchMakingModule,

    BullModule.registerQueue({
      name: SocketQueues.CheckSocketNodes,
    }),
    BullBoardModule.forFeature({
      name: SocketQueues.CheckSocketNodes,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    SocketsGateway,
    CheckSocketNodeJob,
    ...getQueuesProcessors("Sockets"),
    loggerFactory(),
  ],
})
export class SocketsModule {
  constructor(
    @InjectQueue(SocketQueues.CheckSocketNodes) private queue: Queue,
  ) {
    void queue.add(
      CheckSocketNodeJob.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );
  }
}
