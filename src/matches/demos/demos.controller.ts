import {
  Controller,
  Get,
  Req,
  Res,
  Post,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { Request, Response } from "express";
import zlib from "zlib";
import path from "path";
import archiver from "archiver";
import { HasuraService } from "../../hasura/hasura.service";
import { S3Service } from "../../s3/s3.service";
import { S3Interceptor } from "../../s3/s3.interceptor";

@Controller("/matches/:matchId/demos")
export class DemosController {
  constructor(
    private readonly s3: S3Service,
    private readonly hasura: HasuraService
  ) {}

  @Get("/")
  @Get("map/:mapId?")
  public async downloadDemo(
    @Req() request: Request,
    @Res() response: Response
  ) {
    const { matchId, mapId } = request.params;

    const { match_map_demos: demos } = await this.hasura.query({
      match_map_demos: [
        {
          where: {
            match_id: {
              _eq: matchId,
            },
            ...(mapId
              ? {
                  match_map_id: {
                    _eq: matchId,
                  },
                }
              : {}),
          },
        },
        {
          id: true,
          file: true,
          size: true,
        },
      ],
    });

    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${matchId}-demos.zip"`,
    });

    const archive = archiver("zip", {
      zlib: { level: zlib.constants.Z_NO_COMPRESSION },
    });

    archive.pipe(response);

    for (const demo of demos) {
      if (!(await this.s3.has(demo.file))) {
        await this.hasura.mutation({
          delete_match_map_demos_by_pk: [
            {
              id: demo.id,
            },
            {
              id: true,
            },
          ],
        });
        continue;
      }

      archive.append(await this.s3.get(demo.file), {
        name: path.basename(demo.file),
      });
    }

    void archive.finalize();
  }

  @Post("map/:mapId")
  @UseInterceptors(
    S3Interceptor((request: Request, file: Express.Multer.File) => {
      const { matchId, mapId } = request.params;

      return `${matchId}/${mapId}/demos/${file.originalname}`;
    })
  )
  public async uploadDemo(
    @Req() request: Request,
    @UploadedFile() file: Express.Multer.File
  ) {
    const { matchId, mapId } = request.params;

    const filename = `${matchId}/${mapId}/demos/${file.originalname}`;

    const size = file.size;

    await this.hasura.mutation({
      insert_match_map_demos_one: [
        {
          object: {
            size,
            file: filename,
            match_id: matchId,
            match_map_id: mapId,
          },
        },
        {
          id: true,
        },
      ],
    });
  }
}
