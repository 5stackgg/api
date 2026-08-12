import {
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

  // WHIP/WHEP bodies are `application/sdp`, a content type neither of the
  // parsers registered in main.ts claims, so the stream is still unread here.
  private readRawBody(request: Request): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
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

  // The player routes are gated by the secret token alone: the phone scanning
  // the QR code has no session of its own.

  @Post("player/:token/whip")
  public async playerPublish(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await this.readRawBody(request);

    await this.sendSdp(response, () =>
      this.camera.proxyPlayerPublish(token, sdp),
    );
  }

  @Get("player/:token/status")
  public async playerStatus(@Param("token") token: string) {
    return this.camera.getPlayerStatus(token);
  }

  @Post("player/:token/talk/whep")
  public async playerTalk(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const sdp = await this.readRawBody(request);

    await this.sendSdp(response, () => this.camera.proxyPlayerTalk(token, sdp));
  }

  @Get("player/:token/talk/status")
  public async playerTalkStatus(@Param("token") token: string) {
    return this.camera.getPlayerTalkStatus(token);
  }

  @Post("player/:token/talk/hangup")
  public async playerTalkHangup(@Param("token") token: string) {
    await this.camera.hangupPlayerTalk(token);

    return { ok: true };
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
    const sdp = await this.readRawBody(request);

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
    const sdp = await this.readRawBody(request);

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
