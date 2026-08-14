import { Logger, Module } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { VoiceController } from "./voice.controller";
import { VoiceGateway } from "./voice.gateway";
import { VoiceService } from "./voice.service";
import { VoiceQueues } from "./enums/VoiceQueues";
import { MonitorVoiceChannels } from "./jobs/MonitorVoiceChannels";
import { PostgresModule } from "../postgres/postgres.module";
import { MediaMtxModule } from "../mediamtx/mediamtx.module";
import { RedisModule } from "../redis/redis.module";
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [
    PostgresModule,
    MediaMtxModule,
    RedisModule,
    BullModule.registerQueue({
      name: VoiceQueues.Monitor,
    }),
    BullBoardModule.forFeature({
      name: VoiceQueues.Monitor,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [VoiceController],
  // Pushes go out over the Redis channel the sockets service already subscribes
  // to on every pod, so they reach every client without this module taking a
  // dependency on SocketsModule and the module graph that drags in.
  providers: [
    VoiceService,
    VoiceGateway,
    MonitorVoiceChannels,
    ...getQueuesProcessors("Voice"),
    loggerFactory(),
  ],
  exports: [VoiceService],
})
export class VoiceModule {
  constructor(
    private readonly logger: Logger,
    @InjectQueue(VoiceQueues.Monitor) monitorQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    // Matches the camera monitor's cadence: both are watching the same MediaMTX
    // for the same kind of ungraceful drop, and a client that has stopped
    // publishing should disappear from the party in about the time it takes to
    // notice they have gone quiet.
    void monitorQueue.add(
      MonitorVoiceChannels.name,
      {},
      {
        repeat: {
          every: 10_000,
        },
      },
    );
  }
}
