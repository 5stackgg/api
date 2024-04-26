import { Controller, Get, Req } from "@nestjs/common";
import { Request } from "express";
@Controller()
export class AppController {
  @Get("me")
  public me(@Req() request: Request) {
    return request.user;
  }
}
