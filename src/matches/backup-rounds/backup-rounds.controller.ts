import {
  Controller,
  Get,
  Req,
  Post,
  UseInterceptors,
  UploadedFile,
  StreamableFile,
} from "@nestjs/common";
import { Request } from "express";
import zlib from "zlib";
import path from "path";
import archiver from "archiver";
import { S3Service } from "../../s3/s3.service";
import { S3Interceptor } from "../../s3/s3.interceptor";
import { HasuraService } from "../../hasura/hasura.service";

@Controller("/matches/:matchId/backup-rounds")
export class BackupRoundsController {
  constructor(
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
  ) {}

  @Get("map/:mapId")
  public async downloadMapBackupRounds(@Req() request: Request) {
    const { matchId, mapId } = request.params;

    const { match_map_rounds } = await this.hasura.query({
      match_map_rounds: {
        __args: {
          where: {
            match_map_id: {
              _eq: mapId,
            },
            backup_file: {
              _is_null: false,
            },
          },
        },
        id: true,
        backup_file: true,
      },
    });

    if (match_map_rounds.length === 0) {
      return false;
    }

    const archive = archiver("zip", {
      zlib: { level: zlib.constants.Z_NO_COMPRESSION },
    });

    for (const map_round of match_map_rounds) {
      if (!(await this.s3.has(map_round.backup_file))) {
        await this.hasura.mutation({
          update_match_map_rounds_by_pk: {
            __args: {
              pk_columns: {
                id: map_round.id,
              },
              _set: {
                backup_file: null,
              },
            },
            __typename: true,
          },
        });
        continue;
      }

      archive.append(await this.s3.get(map_round.backup_file), {
        name: path.basename(map_round.backup_file),
      });
    }

    void archive.finalize();

    return new StreamableFile(archive, {
      type: "application/zip",
      disposition: `attachment; filename="${matchId}-backup-rounds.zip"`,
    });
  }

  @Post("map/:mapId/round/:round")
  @UseInterceptors(
    S3Interceptor((request: Request, file: Express.Multer.File) => {
      const { matchId, mapId } = request.params;

      return `${matchId}/${mapId}/backup-rounds/${file.originalname}`;
    }),
  )
  public async uploadBackupRound(
    @Req() request: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const { matchId, mapId, round } = request.params;

    console.log(
      `uploading backup rounds ${matchId}/${mapId}/backup-rounds/${file.originalname}`,
    );
    await this.hasura.mutation({
      update_match_map_rounds: {
        __args: {
          where: {
            match_map_id: {
              _eq: mapId,
            },
            round: {
              _eq: parseInt(round),
            },
          },
          _set: {
            backup_file: `${matchId}/${mapId}/backup-rounds/${file.originalname}`,
          },
        },
        affected_rows: true,
      },
    });
  }
}
