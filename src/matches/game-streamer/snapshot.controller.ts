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
import { HasuraService } from "../../hasura/hasura.service";
import { User } from "../../auth/types/User";

const SNAPSHOT_KINDS: SnapshotKind[] = [
  "live",
  "demo",
  "bake",
  "clips",
  "nades",
];

@Controller("snapshots")
export class SnapshotController {
  constructor(
    private readonly gameStreamer: GameStreamerService,
    private readonly streamAccess: StreamAccessService,
    private readonly hasura: HasuraService,
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

    let requireLogin = true;
    if (kind === "live") {
      // Gated by the same login requirement as live streams.
      requireLogin = await this.streamAccess.requireLoginForLiveStreams();
      if (requireLogin && !(await this.streamAccess.authorize(request, id))) {
        throw new ForbiddenException("not authorized to view this stream");
      }
    } else if (
      !(await this.canSeeRender(
        kind as Exclude<SnapshotKind, "live">,
        id,
        request.user as User | undefined,
      ))
    ) {
      throw new ForbiddenException("not authorized to view this render");
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

  // A render's progress frame is shown beside the row it belongs to, so it is
  // shown to whoever may read that row, asked of Hasura as them.
  private async canSeeRender(
    kind: Exclude<SnapshotKind, "live">,
    id: string,
    viewer: User | undefined,
  ): Promise<boolean> {
    if (!viewer) {
      return false;
    }
    try {
      switch (kind) {
        case "demo": {
          const { match_demo_sessions_by_pk } = await this.hasura.query(
            { match_demo_sessions_by_pk: { __args: { id }, id: true } },
            viewer.steam_id,
          );
          return !!match_demo_sessions_by_pk;
        }
        case "bake": {
          const { game_server_nodes_by_pk } = await this.hasura.query(
            { game_server_nodes_by_pk: { __args: { id }, id: true } },
            viewer.steam_id,
          );
          return !!game_server_nodes_by_pk;
        }
        case "clips": {
          const { clip_render_jobs_by_pk } = await this.hasura.query(
            { clip_render_jobs_by_pk: { __args: { id }, id: true } },
            viewer.steam_id,
          );
          return !!clip_render_jobs_by_pk;
        }
        case "nades": {
          const { utility_lineup_renders_by_pk } = await this.hasura.query(
            { utility_lineup_renders_by_pk: { __args: { id }, id: true } },
            viewer.steam_id,
          );
          return !!utility_lineup_renders_by_pk;
        }
      }
    } catch {
      return false;
    }
  }
}
