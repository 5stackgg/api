import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ClipsService } from "./clips.service";
import { ClipRendersController } from "./clip-renders.controller";
import { HasuraModule } from "../../hasura/hasura.module";
import { S3Module } from "../../s3/s3.module";
import { GameStreamerModule } from "../game-streamer/game-streamer.module";
import { MatchQueues } from "../enums/MatchQueues";
import { loggerFactory } from "../../utilities/LoggerFactory";

// The ClipRenderBatch queue + its worker live in MatchesModule (the
// worker has cross-module deps and lives next to its sibling jobs).
// Here we re-register the queue so ClipsService can `@InjectQueue`
// the producer side without importing MatchesModule (which would be
// circular: matches → clips → matches). Bull/BullMQ's
// registerQueue is additive — same queue name shares the connection.
@Module({
  imports: [
    HasuraModule,
    S3Module,
    GameStreamerModule,
    BullModule.registerQueue({ name: MatchQueues.ClipRenderBatch }),
  ],
  controllers: [ClipRendersController],
  providers: [ClipsService, loggerFactory()],
  exports: [ClipsService],
})
export class ClipsModule {}
