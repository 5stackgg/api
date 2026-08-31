import { Controller, Post, Req, UseGuards } from "@nestjs/common";
import { TelemetryService } from "./telemetry.service";
import { HasuraAction } from "../hasura/hasura.controller";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { ThrottlerBehindProxyGuard } from "src/auth/strategies/ThrottlerBehindProxyGuard";

@Controller("telemetry")
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  // Throttled per address rather than per install: several panels can share one
  // NAT, so a limit of 1 would silently drop every heartbeat but the first.
  @UseGuards(ThrottlerBehindProxyGuard)
  @Throttle({ default: { limit: 20, ttl: 59 * 60 * 1000 } })
  @Post()
  public async telemetry(@Req() request: Request) {
    await this.telemetryService.record(
      request.headers["cf-connecting-ip"] as string,
      request.headers["cf-ipcountry"] as string,
      request.body,
    );
  }

  // Defaults to the whole fleet, 5stack.gg included: it reports like any other
  // panel and its history is fleet history. The page passes false to set the
  // flagship aside, which is the only view that answers what everybody else is
  // running.
  @HasuraAction()
  public async telemetryStats(data: { includeSelf?: boolean }) {
    return await this.telemetryService.getFleetStats(data?.includeSelf ?? true);
  }
}
