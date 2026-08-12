import { Module } from "@nestjs/common";
import { VoiceController } from "./voice.controller";
import { VoiceService } from "./voice.service";
import { PostgresModule } from "../postgres/postgres.module";
import { MediaMtxModule } from "../mediamtx/mediamtx.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [PostgresModule, MediaMtxModule],
  controllers: [VoiceController],
  providers: [VoiceService, loggerFactory()],
  exports: [VoiceService],
})
export class VoiceModule {}
