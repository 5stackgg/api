import { Module } from "@nestjs/common";
import { MediaMtxService } from "./mediamtx.service";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  exports: [MediaMtxService],
  providers: [MediaMtxService, loggerFactory()],
})
export class MediaMtxModule {}
