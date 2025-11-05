import { Controller, Post, Req, UseGuards } from "@nestjs/common";
import { TelemetryService } from "./telemetry.service";
import { HasuraAction } from "../hasura/hasura.controller";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { ThrottlerBehindProxyGuard } from "src/auth/strategies/ThrottlerBehindProxyGuard";

@Controller("telemetry")
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @UseGuards(ThrottlerBehindProxyGuard)
  @Throttle({ default: { limit: 1, ttl: 59 * 60 * 1000 } })
  @Post()
  public async telemetry(@Req() request: Request) {
    await this.telemetryService.record(
      request.headers["cf-connecting-ip"] as string,
      request.body,
    );
  }

  @HasuraAction()
  public async telemetryStats() {
    return {
      online: await this.telemetryService.getOnlineSystemsCount(),
    };
  }
}
