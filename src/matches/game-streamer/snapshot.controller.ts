import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Req,
  Res,
} from "@nestjs/common";
import { Request, Response } from "express";
import { GameStreamerService, SnapshotKind } from "./game-streamer.service";
import { StreamAccessService } from "./stream-access.service";

const SNAPSHOT_KINDS: SnapshotKind[] = ["live", "demo", "bake", "clips"];

@Controller("snapshots")
export class SnapshotController {
  constructor(
    private readonly gameStreamer: GameStreamerService,
    private readonly streamAccess: StreamAccessService,
  ) {}

  @Get(":kind/:id")
  public async getSnapshot(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (!SNAPSHOT_KINDS.includes(kind as SnapshotKind)) {
      throw new BadRequestException("invalid snapshot kind");
    }

    // Live snapshots are gated by the same login requirement as live streams.
    const requireLogin =
      kind === "live" &&
      (await this.streamAccess.requireLoginForLiveStreams());
    if (requireLogin && !(await this.streamAccess.authorize(request, id))) {
      throw new ForbiddenException("not authorized to view this stream");
    }

    const image = await this.gameStreamer.getSnapshot(kind as SnapshotKind, id);
    if (!image) {
      throw new NotFoundException("no snapshot available");
    }
    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader(
      "Cache-Control",
      requireLogin ? "private, max-age=15" : "public, max-age=15",
    );
    response.setHeader("Content-Length", String(image.length));
    return response.status(200).end(image);
  }
}
