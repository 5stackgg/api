import { Controller, Get, Request, UseGuards } from "@nestjs/common";

@Controller()
export class AppController {
  @Get("me")
  me(@Request() request): string {
    return request.user;
  }
}
