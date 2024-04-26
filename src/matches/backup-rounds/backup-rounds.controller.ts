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
import MatchAbstractController from "../MatchAbstractController";
import { HasuraService } from "../../hasura/hasura.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { S3Service } from "../../s3/s3.service";
import { FileInterceptor } from "@nestjs/platform-express";

@Controller("/matches/:matchId/backup-rounds")
export class BackupRoundsController extends MatchAbstractController {
  constructor(
    hasura: HasuraService,
    matchAssistant: MatchAssistantService,
    private readonly s3: S3Service
  ) {
    super(hasura, matchAssistant);
  }

  @Get("map/:mapId")
  public async downloadMapBackupRounds(
    @Req() request: Request,
    @Res() response: Response
  ) {
    const { matchId, mapId } = request.params;

    if (!(await this.verifyApiPassword(request, matchId))) {
      response.status(401).end();
      return;
    }

    const { match_map_rounds } = await this.hasura.query({
      match_map_rounds: [
        {
          where: {
            match_map_id: {
              _eq: mapId,
            },
            backup_file: {
              _is_null: false,
            },
          },
        },
        {
          backup_file: true,
        },
      ],
    });

    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${matchId}-backup.zip"`,
    });

    const archive = archiver("zip", {
      zlib: { level: zlib.constants.Z_NO_COMPRESSION },
    });

    archive.pipe(response);

    for (const map_round of match_map_rounds) {
      if (!(await this.s3.has(map_round.backup_file))) {
        continue;
      }

      archive.append(await this.s3.get(map_round.backup_file), {
        name: path.basename(map_round.backup_file),
      });
    }

    void archive.finalize();
  }

  @Post("map/:mapId/round/:round")
  @UseInterceptors(FileInterceptor("file"))
  public async uploadBackupRound(
    @Req() request: Request,
    @UploadedFile() file: File
  ) {
    const { matchId, mapId, round } = request.params;

    if (!(await this.verifyApiPassword(request, matchId))) {
      return;
    }
    const filename = `${matchId}/${mapId}/backup-rounds/${file.name}`;

    void this.s3.put(filename, file.stream()).then(async () => {
      await this.hasura.mutation({
        update_match_map_rounds: [
          {
            where: {
              round: {
                _eq: parseInt(round) + 1,
              },
            },
            _set: {
              backup_file: filename,
            },
          },
          {
            affected_rows: true,
          },
        ],
      });
    });
  }
}
