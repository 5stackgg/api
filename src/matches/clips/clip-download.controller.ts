import {
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { Response } from "express";
import { S3Service } from "../../s3/s3.service";
import { HasuraService } from "../../hasura/hasura.service";

@Controller("/clips/:clipId")
export class ClipDownloadController {
  constructor(
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
    private readonly logger: Logger,
  ) {}

  @Get()
  public async download(
    @Param("clipId") clipId: string,
    @Query("name") name: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const clip = await this.getClip(clipId);
    if (!clip?.file) {
      response.status(404);
      return { error: "not found" };
    }
    return await this.stream(clip.file, "video/mp4", name, response);
  }

  @Get("thumbnail")
  public async thumbnail(
    @Param("clipId") clipId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const clip = await this.getClip(clipId);
    if (!clip?.thumbnail_url) {
      response.status(404);
      return { error: "not found" };
    }
    return await this.stream(clip.thumbnail_url, "image/jpeg", null, response);
  }

  private async getClip(clipId: string) {
    if (!/^[0-9a-fA-F-]{36}$/.test(clipId)) {
      return null;
    }
    const { match_clips_by_pk } = await this.hasura.query({
      match_clips_by_pk: {
        __args: { id: clipId },
        file: true,
        thumbnail_url: true,
      },
    });
    return match_clips_by_pk;
  }

  private async stream(
    key: string,
    contentType: string,
    downloadName: string | null | undefined,
    response: Response,
  ) {
    if (!(await this.s3.has(key))) {
      response.status(404);
      return { error: "not found" };
    }

    const safeName = (downloadName ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
    const disposition =
      safeName.length > 0
        ? `attachment; filename="${safeName}"`
        : "inline";

    try {
      const stream = await this.s3.get(key);
      return new StreamableFile(stream, { type: contentType, disposition });
    } catch (error) {
      this.logger.error(
        `failed to stream ${key}: ${(error as Error)?.message}`,
      );
      response.status(500);
      return { error: "internal" };
    }
  }
}
