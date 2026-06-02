import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { GameStreamerService, SnapshotKind } from "./game-streamer.service";

const SNAPSHOT_KINDS: SnapshotKind[] = ["live", "demo", "bake", "clips"];

@Controller("snapshots")
export class SnapshotController {
  constructor(private readonly gameStreamer: GameStreamerService) {}

  @Get(":kind/:id")
  public async getSnapshot(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Res() response: Response,
  ) {
    if (!SNAPSHOT_KINDS.includes(kind as SnapshotKind)) {
      throw new BadRequestException("invalid snapshot kind");
    }
    const image = await this.gameStreamer.getSnapshot(kind as SnapshotKind, id);
    if (!image) {
      throw new NotFoundException("no snapshot available");
    }
    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader("Cache-Control", "public, max-age=15");
    response.setHeader("Content-Length", String(image.length));
    return response.status(200).end(image);
  }
}
