import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Param,
  ParseIntPipe,
} from "@nestjs/common";
import { Request, Response } from "express";
import { MatchRelayService } from "./match-relay.service";

@Controller("match-relay/:id")
export class MatchRelayController {
  constructor(private readonly matchRelayService: MatchRelayService) {}

  @Get("sync")
  public handleSyncGet(
    @Param("id") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.getSyncInfo(request, response, matchId);
  }

  @Get(":fragment/start")
  public handleGetStart(
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Res() response: Response,
  ) {
    this.matchRelayService.getStart(response, matchId, fragment);
  }

  @Get(":fragment/full")
  public handleGetFull(
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Res() response: Response,
  ) {
    this.matchRelayService.getFragment(
      response,
      matchId,
      fragment,
      "full",
    );
  }

  @Get(":fragment/delta")
  public handleGetDelta(
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Res() response: Response,
  ) {
    this.matchRelayService.getFragment(
      response,
      matchId,
      fragment,
      "delta",
    );
  }

  @Get(":token/:fragment/start")
  public handleGetStartWithToken(
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Res() response: Response,
  ) {
    this.matchRelayService.getStart(response, matchId, fragment);
  }

  @Get(":token/:fragment/full")
  public handleGetFullWithToken(
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Res() response: Response,
  ) {
    this.matchRelayService.getFragment(
      response,
      matchId,
      fragment,
      "full",
    );
  }

  @Get(":token/:fragment/delta")
  public handleGetDeltaWithToken(
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Res() response: Response,
  ) {
    this.matchRelayService.getFragment(
      response,
      matchId,
      fragment,
      "delta",
    );
  }

  @Post(":token/:fragment/start")
  public async handlePostStart(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      token,
      "start",
      matchId,
      fragment,
    );
  }

  @Post(":token/:fragment/full")
  public async handlePostFull(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      token,
      "full",
      matchId,
      fragment,
    );
  }

  @Post(":token/:fragment/delta")
  public async handlePostDelta(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment", ParseIntPipe) fragment: number,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      token,
      "delta",
      matchId,
      fragment,
    );
  }
}
