import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Query,
  StreamableFile,
} from "@nestjs/common";
import { S3Service } from "../../s3/s3.service";
import { HasuraService } from "../../hasura/hasura.service";

@Controller("/clip-files")
export class ClipDownloadController {
  constructor(
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
    private readonly logger: Logger,
  ) {}

  @Get(":clipId")
  public async download(
    @Param("clipId") clipId: string,
    @Query("name") name: string | undefined,
  ) {
    if (!/^[0-9a-fA-F-]{36}$/.test(clipId)) {
      throw new NotFoundException();
    }

    const { match_clips_by_pk: clip } = await this.hasura.query({
      match_clips_by_pk: {
        __args: { id: clipId },
        file: true,
      },
    });

    if (!clip?.file || !(await this.s3.has(clip.file))) {
      throw new NotFoundException();
    }

    const safeName = (name ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
    const disposition =
      safeName.length > 0
        ? `attachment; filename="${safeName}"`
        : "inline";

    try {
      const stream = await this.s3.get(clip.file);
      return new StreamableFile(stream, {
        type: "video/mp4",
        disposition,
      });
    } catch (error) {
      this.logger.error(
        `failed to stream clip ${clip.file}: ${(error as Error)?.message}`,
      );
      throw error;
    }
  }
}
