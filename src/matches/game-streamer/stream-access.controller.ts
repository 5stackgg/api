import { Controller, Get, Options, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { StreamAccessService } from "./stream-access.service";

@Controller("streams")
export class StreamAccessController {
  constructor(private readonly streamAccess: StreamAccessService) {}

  @Get("authorize")
  public async authorize(@Req() request: Request, @Res() response: Response) {
    // nginx forward-auth runs this for every stream request, including the
    // CORS preflight. Preflight (OPTIONS) requests never carry cookies, so
    // gating them would 401 the preflight and surface as a CORS error in the
    // browser before the real (credentialed) request is ever sent. Let them
    // through — the actual GET/POST that follows still gets authorized.
    if (
      String(request.headers["x-original-method"]).toUpperCase() === "OPTIONS"
    ) {
      return response.status(200).end();
    }

    const allowed = await this.streamAccess.authorize(request);
    return response.status(allowed ? 200 : 401).end();
  }

  @Options("authorize")
  public authorizePreflight(@Res() response: Response) {
    return response.status(200).end();
  }
}
