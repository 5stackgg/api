import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TailscaleService } from "./tailscale.service";

@Module({
  providers: [TailscaleService],
  exports: [TailscaleService],
})
export class TailscaleModule {}
