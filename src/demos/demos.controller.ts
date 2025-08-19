import {
  Controller,
  Get,
  Req,
  Post,
  StreamableFile,
  Logger,
  Res,
} from "@nestjs/common";
import { Request, Response } from "express";
import { HasuraService } from "../hasura/hasura.service";
import { S3Service } from "../s3/s3.service";
import archiver from "archiver";
import zlib from "zlib";
import path from "path";

@Controller("/demos/:matchId")
export class DemosController {
  constructor(
    protected readonly s3: S3Service,
    protected readonly hasura: HasuraService,
    protected readonly logger: Logger,
  ) {}

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
        disposition: `attachment; filename="${demo.file}"`,
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

  @Post("pre-signed")
  public async getPreSignedUrl(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const { matchId } = request.params;
    const { mapId, demo } = request.body;

    if (!matchId || !mapId || !demo) {
      return response.status(400).json({
        error: "missing params",
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
          server: {
            is_dedicated: true,
          },
        },
      },
    });

    if (!match_maps_by_pk) {
      return response.status(410).json({
        error: "map not found",
      });
    }

    const { "game-server-node": gameServerNode } = request.query;

    if (
      gameServerNode &&
      match_maps_by_pk.match.server?.is_dedicated === true
    ) {
      return response.status(401).json({
        error: "unauthorized",
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
      (!match_maps_by_pk.match.server ||
        match_maps_by_pk.match.server?.is_dedicated === false) &&
      !["Finished", "Forfeit", "Surrender", "Tie"].includes(
        match_maps_by_pk.match.status,
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

    if (demos.find(({ file }) => file === demo)) {
      return response.status(406).json({
        error: "already uploaded",
      });
    }

    const presignedUrl = await this.s3.getPresignedUrl(
      `${matchId}/${mapId}/demos/${demo}`,
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
    const { matchId } = request.params;
    const { mapId, demo } = request.body;

    if (!matchId || !mapId || !demo) {
      return response.status(400).json({
        error: "missing params",
      });
    }

    await this.hasura.mutation({
      insert_match_map_demos_one: {
        __args: {
          object: {
            match_id: matchId,
            match_map_id: mapId,
            file: `${matchId}/${mapId}/demos/${demo}`,
            size: request.body.size,
          },
        },
        __typename: true,
      },
    });

    return response.status(200).send();
  }

  private async getDemo(demo: { id: string; file: string }) {
    if (!(await this.s3.has(demo.file))) {
      await this.hasura.mutation({
        delete_match_map_demos_by_pk: {
          __args: {
            id: demo.id,
          },
          __typename: true,
        },
      });
      throw Error("demo missing");
    }

    return await this.s3.get(demo.file);
  }
}
