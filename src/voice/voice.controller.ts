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
import { VoiceService } from "./voice.service";
import { User } from "../auth/types/User";

@Controller("voice")
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

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

  @Post(":lobbyId/whip")
  public async publish(
    @Param("lobbyId") lobbyId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () => this.voice.publish(lobbyId, user, sdp));
  }

  // Declared ahead of the `:steamId` routes below so a literal `cam` segment is
  // never a candidate steam id.
  @Post(":lobbyId/cam/whip")
  public async publishVideo(
    @Param("lobbyId") lobbyId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () =>
      this.voice.publishVideo(lobbyId, user, sdp),
    );
  }

  @Post(":lobbyId/cam/stop")
  public async stopVideo(
    @Param("lobbyId") lobbyId: string,
    @Req() request: Request,
  ) {
    await this.voice.stopVideo(lobbyId, this.requireUser(request));

    return { ok: true };
  }

  @Post(":lobbyId/:steamId/whep")
  public async subscribe(
    @Param("lobbyId") lobbyId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () =>
      this.voice.subscribe(lobbyId, steamId, user, sdp),
    );
  }

  @Post(":lobbyId/:steamId/cam/whep")
  public async subscribeVideo(
    @Param("lobbyId") lobbyId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = this.readSdp(request);

    await this.sendSdp(response, () =>
      this.voice.subscribeVideo(lobbyId, steamId, user, sdp),
    );
  }

  // Where this player already is, across every window and device -- the tab
  // bridge only ever sees tabs of the same browser profile.
  @Get("active")
  public async active(@Req() request: Request) {
    return this.voice.activeChannel(this.requireUser(request));
  }

  // Not scoped to a channel: the same relay serves every call, and a client
  // needs this before it has picked one.
  @Get("ice-servers")
  public async iceServers(@Req() request: Request) {
    return this.voice.iceServers(this.requireUser(request));
  }

  @Get(":lobbyId/participants")
  public async participants(
    @Param("lobbyId") lobbyId: string,
    @Req() request: Request,
  ) {
    return this.voice.participants(lobbyId, this.requireUser(request));
  }

  @Post(":lobbyId/leave")
  public async leave(
    @Param("lobbyId") lobbyId: string,
    @Req() request: Request,
  ) {
    await this.voice.leave(lobbyId, this.requireUser(request));

    return { ok: true };
  }
}
