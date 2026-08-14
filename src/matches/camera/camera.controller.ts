import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { Request, Response } from "express";
import { CameraService } from "./camera.service";
import { CameraMonitorService } from "./camera-monitor.service";
import { User } from "../../auth/types/User";

@Controller("matches/camera")
export class CameraController {
  constructor(
    private readonly camera: CameraService,
    private readonly monitor: CameraMonitorService,
  ) {}

  // WHIP/WHEP bodies are `application/sdp`, parsed by the text parser
  // registered in main.ts.
  private readSdp(request: Request): string {
    const sdp = request.body;

    if (typeof sdp !== "string" || !sdp) {
      throw new BadRequestException("expected an application/sdp body");
    }

    return sdp;
  }

  private requireUser(request: Request) {
    const user = request.user as User | undefined;

    if (!user) {
      throw new ForbiddenException("Authentication required");
    }

    return user;
  }

  private async sendSdp(response: Response, answer: () => Promise<string>) {
    try {
      response.status(200).type("application/sdp").send(await answer());
    } catch (error) {
      response.status(400).type("text/plain").send((error as Error).message);
    }
  }

  // The player routes are gated by the session, like everything else. They used
  // to take a minted token instead, because the phone scanning the QR had no
  // login of its own -- it does now, and the QR carries only a URL.

  @Post("player/:matchId/whip")
  public async playerPublish(
    @Param("matchId") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () =>
      this.camera.proxyPlayerPublish(matchId, user, sdp),
    );
  }

  @Get("player/:matchId/status")
  public async playerStatus(
    @Param("matchId") matchId: string,
    @Req() request: Request,
  ) {
    return this.camera.getPlayerStatus(matchId, this.requireUser(request));
  }

  @Post("player/:matchId/talk/whep")
  public async playerTalk(
    @Param("matchId") matchId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () =>
      this.camera.proxyPlayerTalk(matchId, user, sdp),
    );
  }

  @Get("player/:matchId/talk/status")
  public async playerTalkStatus(
    @Param("matchId") matchId: string,
    @Req() request: Request,
  ) {
    return this.camera.getPlayerTalkStatus(matchId, this.requireUser(request));
  }

  @Post("player/:matchId/talk/hangup")
  public async playerTalkHangup(
    @Param("matchId") matchId: string,
    @Req() request: Request,
  ) {
    await this.camera.hangupPlayerTalk(matchId, this.requireUser(request));

    return { ok: true };
  }

  // The broadcast pod: no session, authenticates as the match itself.
  @Post("broadcast/:matchId/:steamId/whep")
  public async broadcastWatch(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const originAuth = request.headers["x-origin-auth"];
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () =>
      this.camera.proxyBroadcastWatch(matchId, steamId, originAuth, sdp),
    );
  }

  // The admin routes are gated by session + organizer.

  @Get("admin/:matchId/players")
  public async adminPlayers(
    @Param("matchId") matchId: string,
    @Req() request: Request,
  ) {
    return this.camera.getPlayersWithCameraStatus(
      matchId,
      this.requireUser(request),
      await this.monitor.healthFor(matchId),
    );
  }

  @Post("admin/:matchId/:steamId/whep")
  public async adminWatch(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () =>
      this.camera.proxyAdminWatch(matchId, steamId, user, sdp),
    );
  }

  @Post("admin/:matchId/:steamId/talk/whip")
  public async adminTalk(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () =>
      this.camera.proxyAdminTalk(matchId, steamId, user, sdp),
    );
  }

  @Get("admin/:matchId/:steamId/talk/status")
  public async adminTalkStatus(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
  ) {
    return this.camera.getAdminTalkStatus(
      matchId,
      steamId,
      this.requireUser(request),
    );
  }

  @Post("admin/:matchId/:steamId/talk/hangup")
  public async adminTalkHangup(
    @Param("matchId") matchId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
  ) {
    await this.camera.hangupAdminTalk(
      matchId,
      steamId,
      this.requireUser(request),
    );

    return { ok: true };
  }
}
