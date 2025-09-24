import { Module } from "@nestjs/common";
import { TailscaleService } from "./tailscale.service";
import { loggerFactory } from "src/utilities/LoggerFactory";

@Module({
  providers: [TailscaleService, loggerFactory()],
  exports: [TailscaleService],
})
export class TailscaleModule {}
