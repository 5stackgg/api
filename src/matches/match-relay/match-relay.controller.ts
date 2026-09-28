import { Controller, Get, Post, Req, Res, Param, Logger } from "@nestjs/common";
import { Request, Response } from "express";
import { MatchRelayService } from "./match-relay.service";
import { FragmentField } from "./types/fragment.types";

@Controller("match-relay/:id")
export class MatchRelayController {
  constructor(
    private readonly logger: Logger,
    private readonly matchRelayService: MatchRelayService,
  ) {}

  @Get("sync")
  public async handleSyncGet(
    @Param("id") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.relay(matchId, response, () =>
      this.matchRelayService.getSyncInfo(request, response, matchId),
    );
  }

  @Get(":fragment/start")
  public async handleGetStart(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    await this.relay(matchId, response, () =>
      this.matchRelayService.getStart(response, matchId, parseInt(fragment)),
    );
  }

  @Get(":fragment/full")
  public async handleGetFull(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    await this.getFragment(response, matchId, fragment, "full");
  }

  @Get(":fragment/delta")
  public async handleGetDelta(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    await this.getFragment(response, matchId, fragment, "delta");
  }

  @Get(":token/:fragment/start")
  public async handleGetStartWithToken(
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    await this.relay(matchId, response, () =>
      this.matchRelayService.getStart(response, matchId, parseInt(fragment)),
    );
  }

  @Get(":token/:fragment/full")
  public async handleGetFullWithToken(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    await this.getFragment(response, matchId, fragment, "full", token);
  }

  @Get(":token/:fragment/delta")
  public async handleGetDeltaWithToken(
    @Param("id") matchId: string,
    @Param("token") token: string,
    @Param("fragment") fragment: string,
    @Res() response: Response,
  ) {
    await this.getFragment(response, matchId, fragment, "delta", token);
  }

  @Post(":token/:fragment/start")
  public async handlePostStart(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.postField(request, response, token, "start", matchId, fragment);
  }

  @Post(":token/:fragment/full")
  public async handlePostFull(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.postField(request, response, token, "full", matchId, fragment);
  }

  @Post(":token/:fragment/delta")
  public async handlePostDelta(
    @Param("token") token: string,
    @Param("id") matchId: string,
    @Param("fragment") fragment: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.postField(request, response, token, "delta", matchId, fragment);
  }

  private getFragment(
    response: Response,
    matchId: string,
    fragment: string,
    field: FragmentField,
    token?: string,
  ) {
    return this.relay(matchId, response, () =>
      this.matchRelayService.getFragment(
        response,
        matchId,
        parseInt(fragment),
        field,
        token,
      ),
    );
  }

  private postField(
    request: Request,
    response: Response,
    token: string,
    field: FragmentField,
    matchId: string,
    fragment: string,
  ) {
    return this.relay(matchId, response, () =>
      this.matchRelayService.postField(
        request,
        response,
        token,
        field,
        matchId,
        parseInt(fragment),
      ),
    );
  }

  private async relay(
    matchId: string,
    response: Response,
    handle: () => Promise<void>,
  ) {
    try {
      await handle();
    } catch (error) {
      this.logger.error(
        `[${matchId}] relay request failed: ${(error as Error)?.message}`,
      );
      if (!response.headersSent) {
        response.writeHead(503, { "Cache-Control": "no-store" });
      }
      response.end();
    }
  }
}
