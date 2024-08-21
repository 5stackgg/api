import {
  Controller,
  Get,
  Req,
  Post,
  UseInterceptors,
  UploadedFile,
  StreamableFile,
  Logger,
} from "@nestjs/common";
import { Request } from "express";
import { HasuraService } from "../../hasura/hasura.service";
import { S3Service } from "../../s3/s3.service";
import { S3Interceptor } from "../../s3/s3.interceptor";
import archiver from "archiver";
import zlib from "zlib";
import path from "path";

@Controller("/matches/:matchId/demos")
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

  @Post("map/:mapId")
  @UseInterceptors(
    S3Interceptor((request: Request, file: Express.Multer.File) => {
      const { matchId, mapId } = request.params;

      return `${matchId}/${mapId}/demos/${file.originalname}`;
    }),
  )
  public async uploadDemo(
    @Req() request: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const { matchId, mapId } = request.params;

    const filename = `${matchId}/${mapId}/demos/${file.originalname}`;

    const { size } = await this.s3.stat(filename);

    await this.hasura.mutation({
      insert_match_map_demos_one: {
        __args: {
          object: {
            size,
            file: filename,
            match_id: matchId,
            match_map_id: mapId,
          },
        },
        __typename: true,
      },
    });
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
