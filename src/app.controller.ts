import { Controller, Get, Request, UseGuards } from "@nestjs/common";
import { AppService } from "./app.service";
import { SteamGuard } from "./auth/strategies/SteamGuard";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @UseGuards(SteamGuard)
  @Get("me")
  me(@Request() request): string {
    return request.user;
  }
}
