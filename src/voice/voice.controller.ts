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
import { VoiceService } from "./voice.service";
import { User } from "../auth/types/User";

@Controller("voice")
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  // WHIP/WHEP bodies are `application/sdp`, which neither parser registered in
  // main.ts claims, so the stream is still unread here.
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

  @Post(":lobbyId/whip")
  public async publish(
    @Param("lobbyId") lobbyId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await this.readRawBody(request);

    await this.sendSdp(response, () => this.voice.publish(lobbyId, user, sdp));
  }

  @Post(":lobbyId/:steamId/whep")
  public async subscribe(
    @Param("lobbyId") lobbyId: string,
    @Param("steamId") steamId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const user = this.requireUser(request);
    const sdp = await this.readRawBody(request);

    await this.sendSdp(response, () =>
      this.voice.subscribe(lobbyId, steamId, user, sdp),
    );
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
