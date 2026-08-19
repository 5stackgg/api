import {
  Controller,
  Get,
  Req,
  Post,
  StreamableFile,
  Logger,
  Res,
  UseGuards,
  Header,
  NotFoundException,
} from "@nestjs/common";
import { ApiKeyGuard } from "../auth/strategies/ApiKeyGuard";
import { Request, Response } from "express";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction } from "../hasura/hasura.controller";
import { S3Service } from "../s3/s3.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import archiver from "archiver";
import zlib from "zlib";
import path from "path";
import { Readable } from "stream";
import { DemoMetadataService, demoKey } from "./demo-metadata.service";
import { ParsedDemo } from "./demo-parser.service";

@Controller("/demos/:matchId")
export class DemosController {
  constructor(
    protected readonly s3: S3Service,
    protected readonly hasura: HasuraService,
    protected readonly postgres: PostgresService,
    protected readonly logger: Logger,
    protected readonly demoMetadata: DemoMetadataService,
    private readonly notifications: NotificationsService,
  ) {}

  private static isValidDemoName(demo: unknown): demo is string {
    return typeof demo === "string" && /^[a-zA-Z0-9._-]+\.dem$/.test(demo);
  }

  @UseGuards(ApiKeyGuard)
  @Get("map/:mapId")
  public async downloadDemo(@Req() request: Request) {
    const { matchId, mapId } = request.params;

    const { match_map_demos: demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: {
            match_id: {
              _eq: matchId,
            },
            match_map_id: {
              _eq: mapId,
            },
          },
        },
        id: true,
        file: true,
        size: true,
      },
    });

    if (demos.length === 0) {
      throw Error("demos missing");
    }

    if (demos.length === 1) {
      const demo = demos.at(0);
      return new StreamableFile(await this.getDemo(demo), {
        disposition: `attachment; filename="${path.basename(demo.file)}"`,
      });
    }

    const archive = archiver("zip", {
      zlib: { level: zlib.constants.Z_NO_COMPRESSION },
    });

    for (const demo of demos) {
      try {
        archive.append(await this.getDemo(demo), {
          name: path.basename(demo.file),
        });
      } catch (error) {
        this.logger.error(
          `unable to get demo ${demo.file}) : ${error.message}`,
        );
      }
    }

    void archive.finalize();

    return new StreamableFile(archive, {
      type: "application/zip",
      disposition: `attachment; filename="${matchId}-${mapId}-demos.zip"`,
    });
  }

  @UseGuards(ApiKeyGuard)
  @Header("Content-Type", "application/octet-stream")
  @Header("Cache-Control", "private, max-age=300")
  @Get("map/:mapId/playback")
  public async downloadPlaybackBlob(
    @Req() request: Request,
  ): Promise<StreamableFile> {
    const matchId = request.params.matchId as string;
    const mapId = request.params.mapId as string;

    const rows = await this.postgres.query<Array<{ playback_file: string }>>(
      `SELECT playback_file FROM public.match_map_demos
        WHERE match_id = $1::uuid AND match_map_id = $2::uuid
          AND playback_file IS NOT NULL
        LIMIT 1`,
      [matchId, mapId],
    );
    const key = rows.at(0)?.playback_file ?? null;

    if (!key || !(await this.s3.has(key))) {
      throw new NotFoundException("playback blob missing");
    }

    return new StreamableFile(await this.s3.get(key));
  }

  @Post("pre-signed")
  public async getPreSignedUrl(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const { matchId } = request.params;
    const { mapId, demo } = request.body;
    const isGameServerNode = request.query["game-server-node"] === "true";

    if (!matchId || !mapId || !demo) {
      return response.status(400).json({
        error: "missing params",
      });
    }

    if (!DemosController.isValidDemoName(demo)) {
      return response.status(400).json({
        error: "invalid demo filename",
      });
    }

    const { match_maps_by_pk } = await this.hasura.query({
      match_maps_by_pk: {
        __args: {
          id: mapId,
        },
        status: true,
        match: {
          status: true,
        },
      },
    });

    if (!match_maps_by_pk) {
      return response.status(410).json({
        error: "map not found",
      });
    }

    if (
      !match_maps_by_pk.match ||
      match_maps_by_pk.match.status === "Canceled"
    ) {
      return response.status(410).json({
        error: "match cancelled",
      });
    }

    if (
      !["Finished", "Surrendered", "UploadingDemo"].includes(
        match_maps_by_pk.status,
      )
    ) {
      return response.status(409).json({
        error: "map not finished",
      });
    }

    const { match_map_demos: demos } = await this.hasura.query({
      match_map_demos: {
        __args: {
          where: {
            match_id: {
              _eq: matchId,
            },
            match_map_id: {
              _eq: mapId,
            },
          },
        },
        id: true,
        file: true,
        size: true,
      },
    });

    if (
      demos.find(
        ({ file, size }) =>
          file === demo && size !== null && size !== undefined,
      )
    ) {
      return response.status(406).json({
        error: "already uploaded",
      });
    }

    const presignedUrl = await this.s3.getPresignedUrl(
      demoKey(matchId as string, mapId, demo),
      undefined,
      undefined,
      undefined,
      isGameServerNode,
    );

    return response.status(200).json({
      presignedUrl,
    });
  }

  @Post("uploaded")
  public async markDemoAsUploaded(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const matchId = request.params.matchId as string;
    const { mapId, demo } = request.body as {
      mapId?: string;
      demo?: string;
      size?: number;
    };

    if (!matchId || !mapId || !demo) {
      return response.status(400).json({
        error: "missing params",
      });
    }

    if (!DemosController.isValidDemoName(demo)) {
      return response.status(400).json({
        error: "invalid demo filename",
      });
    }

    const file = demoKey(matchId, mapId, demo);
    const matchMapDemoId = await this.upsertDemoRow(
      matchId,
      mapId,
      file,
      request.body.size,
    );

    if (matchMapDemoId) {
      void this.demoMetadata.ensureParsedById(matchMapDemoId);
    }

    return response.status(200).send();
  }

  @Post("parsed")
  public async markDemoAsParsed(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const matchId = request.params.matchId as string;
    const { mapId, demo, parsed } = request.body as {
      mapId?: string;
      demo?: string;
      parsed?: ParsedDemo;
    };

    if (!matchId || !mapId || !demo || !parsed) {
      return response.status(400).json({
        error: "missing params",
      });
    }

    if (!DemosController.isValidDemoName(demo)) {
      return response.status(400).json({
        error: "invalid demo filename",
      });
    }

    const file = demoKey(matchId, mapId, demo);
    const matchMapDemoId = await this.upsertDemoRow(matchId, mapId, file, null);

    if (!matchMapDemoId) {
      return response.status(500).json({ error: "failed to upsert demo row" });
    }

    await this.demoMetadata.persistParsed(matchMapDemoId, parsed);

    // The end of the wait the stats-ready countdown has been showing since
    // WaitingForTV (see the tbu_match_maps trigger). Everyone who played is
    // waiting on exactly this.
    void this.notifyStatsReady(matchId);

    return response.status(200).json({ matchMapDemoId });
  }

  private async notifyStatsReady(matchId: string) {
    try {
      // Fired once per match, not once per demo. A Bo3 parses three of them,
      // and a reparse runs the whole thing again -- either would otherwise send
      // the same "your stats are ready" several times over.
      const [alreadySent] = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id FROM public.notifications
          WHERE type = 'MatchStatsReady' AND entity_id = $1 LIMIT 1`,
        [matchId],
      );

      if (alreadySent) {
        return;
      }

      const players = await this.postgres.query<Array<{ steam_id: string }>>(
        `SELECT DISTINCT mlp.steam_id::text AS steam_id
           FROM public.matches m
           JOIN public.match_lineup_players mlp
             ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
          WHERE m.id = $1::uuid
            AND mlp.steam_id IS NOT NULL`,
        [matchId],
      );

      if (players.length === 0) {
        return;
      }

      const image = await this.notifications.mapPosterImage({ matchId });

      await this.notifications.notifyPlayers("MatchStatsReady", {
        title: "Match Stats Ready",
        message: `Your match stats are ready. <a href="/matches/${matchId}">View Match</a>`,
        role: "user",
        entity_id: matchId,
        steamIds: players.map((player) => player.steam_id),
        data: { image },
      });
    } catch (error) {
      this.logger.warn(
        `unable to notify players that stats are ready for ${matchId}`,
        error,
      );
    }
  }

  private async upsertDemoRow(
    matchId: string,
    mapId: string,
    file: string,
    size: number | null,
  ): Promise<string | null> {
    const bindings = [matchId, mapId, file, size as number] as [
      string,
      string,
      string,
      number,
    ];
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `WITH ins AS (
         INSERT INTO public.match_map_demos (match_id, match_map_id, file, size)
         VALUES ($1::uuid, $2::uuid, $3, $4::int)
         ON CONFLICT (match_map_id, file) DO UPDATE
           SET size = COALESCE(EXCLUDED.size, public.match_map_demos.size)
         RETURNING id
       )
       SELECT id FROM ins`,
      bindings,
    );
    return rows?.[0]?.id ?? null;
  }

  @HasuraAction()
  public async reparseDemo(data: { match_map_id: string }) {
    const demos = await this.demoMetadata.getAllDemosForMap(data.match_map_id);
    if (demos.length === 0) {
      throw Error("no demo for this match map");
    }
    for (const demo of demos) {
      try {
        await this.demoMetadata.reparseById(demo.id);
      } catch (error) {
        this.logger.warn(
          `[reparseDemo] match_map ${data.match_map_id} demo ${demo.id} failed: ${(error as Error)?.message}`,
        );
      }
    }
    return { success: true };
  }

  // Reparses every demo across every map in a match. A Bo3/Bo5 with multiple
  // demos per map would blow past the Hasura action timeout if we awaited the
  // loop here — so we validate upfront and then run the work as fire-and-
  // forget. reparseById's in-flight map dedupes concurrent calls for the same
  // demo, and we run sequentially so a single host isn't trying to spawn N
  // parser processes in parallel.
  @HasuraAction()
  public async reparseMatchDemos(data: { match_id: string }) {
    const demos = await this.demoMetadata.getAllDemosForMatch(data.match_id);
    if (demos.length === 0) {
      throw Error("no demos for this match");
    }
    void (async () => {
      for (const demo of demos) {
        try {
          await this.demoMetadata.reparseById(demo.id);
        } catch (error) {
          this.logger.warn(
            `[reparseMatchDemos] match ${data.match_id} demo ${demo.id} failed: ${(error as Error)?.message}`,
          );
        }
      }
    })();
    return { success: true };
  }

  private async getDemo(demo: { id: string; file: string }) {
    if (DemoMetadataService.isExternalDemoUrl(demo.file)) {
      const res = await fetch(demo.file);
      if (!res.ok || !res.body) {
        throw new Error(`upstream demo fetch ${res.status}`);
      }
      return Readable.fromWeb(res.body as any);
    }

    if (!(await this.s3.has(demo.file))) {
      await this.demoMetadata.deleteDemo(demo.id);
      throw Error("demo missing");
    }

    return await this.s3.get(demo.file);
  }
}
