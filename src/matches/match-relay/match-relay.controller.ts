import { Controller, Get, Post, Req, Res, Param } from "@nestjs/common";
import { Request, Response } from "express";
import { MatchRelayService } from "./match-relay.service";

@Controller("matches/:id/relay")
export class MatchRelayController {
  constructor(private readonly matchRelayService: MatchRelayService) {}

  @Get("sync")
  public handleSyncGet(
    @Param("id") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.respondMatchBroadcastSync(
      request,
      response,
      matchId,
    );
  }

  @Get(":fragment/start")
  public handleGetStart(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.getStart(
      request,
      response,
      matchId,
      parseInt(fragment),
    );
  }

  @Get(":fragment/full")
  public handleGetFull(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.getField(
      request,
      response,
      matchId,
      parseInt(fragment),
      "full",
    );
  }

  @Get(":fragment/delta")
  public handleGetDelta(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.getField(
      request,
      response,
      matchId,
      parseInt(fragment),
      "delta",
    );
  }

  @Get(":token/:fragment/start")
  public handleGetStartWithToken(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.getField(
      request,
      response,
      matchId,
      parseInt(fragment),
      "start",
      token,
    );
  }

  @Get(":token/:fragment/full")
  public handleGetFullWithToken(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.getField(
      request,
      response,
      matchId,
      parseInt(fragment),
      "full",
      token,
    );
  }

  @Get(":token/:fragment/delta")
  public handleGetDeltaWithToken(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.getField(
      request,
      response,
      matchId,
      parseInt(fragment),
      "delta",
      token,
    );
  }

  @Post(":token/:fragment/start")
  public async handlePostStart(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      "start",
      matchId,
      parseInt(fragment),
      token,
    );
  }

  @Post(":token/:fragment/full")
  public async handlePostFull(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      "full",
      matchId,
      parseInt(fragment),
      token,
    );
  }

  @Post(":token/:fragment/delta")
  public async handlePostDelta(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      "delta",
      matchId,
      parseInt(fragment),
      token,
    );
  }
}
