import { Module } from "@nestjs/common";
import { MediaMtxService } from "./mediamtx.service";
import { MediaMtxController } from "./mediamtx.controller";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  controllers: [MediaMtxController],
  exports: [MediaMtxService],
  providers: [MediaMtxService, loggerFactory()],
})
export class MediaMtxModule {}
