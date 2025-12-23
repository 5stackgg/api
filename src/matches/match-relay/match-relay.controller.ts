import { Controller, Get, Post, Req, Res, Param } from "@nestjs/common";
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
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    this.matchRelayService.getStart(response, matchId, parseInt(fragment));
  }

  @Get(":fragment/full")
  public handleGetFull(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    this.matchRelayService.getFragment(
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
    @Res() response: Response,
  ) {
    this.matchRelayService.getFragment(
      response,
      matchId,
      parseInt(fragment),
      "delta",
    );
  }

  @Get(":token/:fragment/start")
  public handleGetStartWithToken(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    this.matchRelayService.getStart(response, matchId, parseInt(fragment));
  }

  @Get(":token/:fragment/full")
  public handleGetFullWithToken(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    this.matchRelayService.getFragment(
      response,
      matchId,
      parseInt(fragment),
      "full",
    );
  }

  @Get(":token/:fragment/delta")
  public handleGetDeltaWithToken(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    this.matchRelayService.getFragment(
      response,
      matchId,
      parseInt(fragment),
      "delta",
    );
  }

  @Post(":token/:fragment/start")
  public async handlePostStart(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      token,
      "start",
      matchId,
      parseInt(fragment),
    );
  }

  @Post(":token/:fragment/full")
  public async handlePostFull(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      token,
      "full",
      matchId,
      parseInt(fragment),
    );
  }

  @Post(":token/:fragment/delta")
  public async handlePostDelta(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    this.matchRelayService.postField(
      request,
      response,
      token,
      "delta",
      matchId,
      parseInt(fragment),
    );
  }
}
