import { Module } from "@nestjs/common";
import { ClipsService } from "./clips.service";
import { ClipRendersController } from "./clip-renders.controller";
import { HasuraModule } from "../../hasura/hasura.module";
import { S3Module } from "../../s3/s3.module";
import { GameStreamerModule } from "../game-streamer/game-streamer.module";
import { DemosModule } from "../../demos/demos.module";
import { loggerFactory } from "../../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, S3Module, GameStreamerModule, DemosModule],
  controllers: [ClipRendersController],
  providers: [ClipsService, loggerFactory()],
  exports: [ClipsService],
})
export class ClipsModule {}
