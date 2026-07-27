import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Get,
  InternalServerErrorException,
  Param,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  ForbiddenException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { SystemService } from "src/system/system.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { S3Service } from "../s3/s3.service";
import { signUploadToken } from "../steam-match-history/uploadToken";
import { User } from "../auth/types/User";
import { e_player_roles_enum } from "generated";
import { NewsService } from "./news.service";

const VIDEO_MAX_SIZE = 512 * 1024 * 1024;
// Anything at or under this posts straight through the API like news images.
// Only bigger files need the multipart bypass — Cloudflare caps proxied
// request bodies at ~100MB and times slow ones out.
const DIRECT_MAX_SIZE = 90 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 64 * 1024 * 1024;

@Controller("news")
export class NewsController {
  private readonly logger = new Logger(NewsController.name);

  constructor(
    private readonly news: NewsService,
    private readonly system: SystemService,
    private readonly s3: S3Service,
  ) {}

  @HasuraAction()
  public async newsPostsAdmin(data: { user?: User }) {
    await this.assertCanPost(data.user);
    return await this.news.listPosts();
  }

  @HasuraAction()
  public async newsPostAdmin(data: { id: string; user?: User }) {
    await this.assertCanPost(data.user);
    return await this.news.getPost(data.id);
  }

  @HasuraAction()
  public async saveNewsPost(data: {
    id?: string | null;
    title: string;
    teaser?: string | null;
    cover_image_url?: string | null;
    content_markdown: string;
    user?: User;
  }) {
    const user = await this.assertCanPost(data.user);
    return await this.news.savePost(
      {
        id: data.id,
        title: data.title,
        teaser: data.teaser,
        cover_image_url: data.cover_image_url,
        content_markdown: data.content_markdown,
      },
      user.steam_id,
    );
  }

  @HasuraAction()
  public async setNewsPostStatus(data: {
    id: string;
    status: string;
    user?: User;
  }) {
    await this.assertCanPost(data.user);
    return await this.news.setStatus(data.id, data.status);
  }

  @HasuraAction()
  public async deleteNewsPost(data: { id: string; user?: User }) {
    await this.assertCanPost(data.user);
    await this.news.deletePost(data.id);
    return { success: true };
  }

  @Post("upload")
  @UseInterceptors(FileInterceptor("file"))
  public async upload(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp|gif)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    await this.assertCanPost(request.user as User | undefined);
    const filename = await this.news.uploadImage(file.buffer, file.mimetype);
    return { success: true, filename };
  }

  @Post("upload/video")
  @UseInterceptors(FileInterceptor("file"))
  public async uploadVideo(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: DIRECT_MAX_SIZE }),
          new FileTypeValidator({ fileType: /video\/mp4/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    await this.assertCanPost(request.user as User | undefined);

    // The mimetype above is client-claimed; confirm the bytes really are mp4.
    if (!this.hasMp4MagicBytes(file.buffer.subarray(0, 12))) {
      throw new BadRequestException("file content does not match its type");
    }

    const filename = await this.news.uploadVideo(file.buffer);
    return { success: true, filename };
  }

  @Post("upload/initiate")
  public async initiateVideoUpload(
    @Req() request: Request,
    @Body() body: { fileSize?: number },
  ): Promise<{
    uploadId: string;
    key: string;
    chunkSize: number;
    parts: Array<{ partNumber: number; url: string }>;
  }> {
    const user = await this.assertCanPost(request.user as User | undefined);

    const fileSize = Number(body.fileSize);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      throw new BadRequestException("invalid file size");
    }
    if (fileSize <= DIRECT_MAX_SIZE) {
      // Small files must use /upload/video; the multipart bypass exists only
      // for bodies too big to proxy through Cloudflare.
      throw new BadRequestException("file is small enough to upload directly");
    }
    if (fileSize > VIDEO_MAX_SIZE) {
      throw new BadRequestException("file exceeds 512MB limit");
    }

    const filename = this.news.generateFilename("mp4");
    const key = this.news.mediaKey(filename);
    const uploadId = await this.s3.createMultipartUpload(key);
    const partCount = Math.ceil(fileSize / UPLOAD_CHUNK_SIZE);
    const workerUrl = await this.news.getCloudflareWorkerUrl();

    // Each part URL carries a short-lived HMAC bound to this key+uploadId so
    // the worker never signs an arbitrary write (same scheme as event media
    // and demo uploads). Without a worker we presign against S3 directly.
    let uploadToken: string | null = null;
    if (workerUrl) {
      const signingSecret = process.env.S3_SECRET;
      if (!signingSecret) {
        throw new InternalServerErrorException(
          "S3_SECRET is not configured; cannot authorize worker uploads",
        );
      }
      uploadToken = signUploadToken(signingSecret, key, uploadId);
    }

    const parts: Array<{ partNumber: number; url: string }> = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      parts.push({
        partNumber,
        url: workerUrl
          ? `${workerUrl}/${key}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}&token=${encodeURIComponent(uploadToken!)}`
          : await this.s3.getPresignedPartUrl(key, uploadId, partNumber),
      });
    }

    this.logger.log(
      `news video initiate steam_id=${user.steam_id} key=${key} parts=${partCount} bytes=${fileSize}`,
    );

    return { uploadId, key, chunkSize: UPLOAD_CHUNK_SIZE, parts };
  }

  @Post("upload/complete")
  public async completeVideoUpload(
    @Req() request: Request,
    @Body() body: { uploadId?: string; key?: string },
  ): Promise<{ success: boolean; filename: string }> {
    const user = await this.assertCanPost(request.user as User | undefined);
    const key = this.news.assertMediaKey(body.key, "mp4");
    if (!body.uploadId) {
      throw new BadRequestException("uploadId required");
    }

    try {
      await this.s3.completeMultipartUpload(key, body.uploadId);
    } catch (error) {
      try {
        await this.s3.abortMultipartUpload(key, body.uploadId);
      } catch (abortError) {
        this.logger.warn(
          `abort after failed complete key=${key}: ${abortError}`,
        );
      }
      throw new BadRequestException(
        `could not assemble upload: ${(error as Error)?.message ?? error}`,
      );
    }

    // /initiate trusts the client-claimed fileSize and presigned part PUTs are
    // uncapped, so the real assembled size is enforced here.
    const { size } = await this.s3.stat(key);
    if (size > VIDEO_MAX_SIZE) {
      await this.s3.remove(key);
      throw new BadRequestException("file exceeds 512MB limit");
    }

    const header = await this.s3.readPrefix(key, 12);
    if (!this.hasMp4MagicBytes(header)) {
      await this.s3.remove(key);
      throw new BadRequestException("file content does not match its type");
    }

    this.logger.log(`news video complete steam_id=${user.steam_id} key=${key}`);

    return { success: true, filename: key.split("/").pop()! };
  }

  @Post("upload/abort")
  public async abortVideoUpload(
    @Req() request: Request,
    @Body() body: { uploadId?: string; key?: string },
  ): Promise<{ success: boolean }> {
    await this.assertCanPost(request.user as User | undefined);
    const key = this.news.assertMediaKey(body.key, "mp4");
    if (!body.uploadId) {
      throw new BadRequestException("uploadId required");
    }
    try {
      await this.s3.abortMultipartUpload(key, body.uploadId);
    } catch (error) {
      this.logger.warn(`abort multipart upload failed key=${key}: ${error}`);
    }
    return { success: true };
  }

  @Post(":slug/view")
  public async trackView(@Param("slug") slug: string) {
    await this.news.trackView(slug);
    return { success: true };
  }

  @Get("image/:filename")
  public async serveImage(
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      throw new NotFoundException("Image not found");
    }

    const result = await this.news.getImageStream(filename);
    if (!result) {
      throw new NotFoundException("Image not found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }

    // Without these handlers an S3 stream error would throw an unhandled
    // 'error' event (crashing the process), and a client that disconnects
    // mid-download would leave the upstream stream open (fd leak).
    result.stream.on("error", (error: Error) => {
      this.logger.error(
        `error streaming news image ${filename}: ${error?.message}`,
        error?.stack,
      );
      result.stream.destroy();
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      result.stream.destroy();
    });

    result.stream.pipe(res);
  }

  // Range support is not optional: iOS <video> refuses to play a 200-only
  // response, the same reason clip downloads serve 206s.
  @Get("video/:filename")
  public async serveVideo(
    @Param("filename") filename: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (!/^[0-9a-f]{24}\.mp4$/.test(filename)) {
      throw new NotFoundException("Video not found");
    }

    const key = this.news.mediaKey(filename);

    let size: number;
    try {
      ({ size } = await this.s3.stat(key));
    } catch (error) {
      if ((error as { code?: string })?.code === "NotFound") {
        throw new NotFoundException("Video not found");
      }
      this.logger.error(`failed to stat ${key}: ${(error as Error)?.message}`);
      response.status(500).json({ error: "internal" });
      return;
    }

    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("X-Content-Type-Options", "nosniff");
    // Filenames are content-random and never reused, so this is safe to hold
    // in shared caches (news articles are public once published).
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const rangeHeader = request.headers.range;
    const range = rangeHeader ? this.parseRange(rangeHeader, size) : null;

    if (rangeHeader && !range) {
      response.setHeader("Content-Range", `bytes */${size}`);
      response.status(416).end();
      return;
    }

    try {
      if (range) {
        const length = range.end - range.start + 1;
        response.status(206);
        response.setHeader(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
        response.setHeader("Content-Length", String(length));
        this.pipeWithCleanup(
          await this.s3.getPartial(key, range.start, length),
          response,
        );
      } else {
        response.status(200);
        response.setHeader("Content-Length", String(size));
        this.pipeWithCleanup(await this.s3.get(key), response);
      }
    } catch (error) {
      this.logger.error(`failed to stream ${key}: ${(error as Error)?.message}`);
      if (!response.headersSent) {
        response.status(500).json({ error: "internal" });
      } else {
        response.destroy();
      }
    }
  }

  private hasMp4MagicBytes(header: Buffer): boolean {
    return header.length >= 8 && header.subarray(4, 8).toString() === "ftyp";
  }

  private parseRange(
    header: string,
    size: number,
  ): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;
    const startStr = match[1];
    const endStr = match[2];
    let start: number;
    let end: number;
    if (startStr === "" && endStr === "") return null;
    if (startStr === "") {
      const suffix = parseInt(endStr, 10);
      if (!Number.isFinite(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(startStr, 10);
      end = endStr === "" ? size - 1 : parseInt(endStr, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < start || start >= size) return null;
    if (end >= size) end = size - 1;
    return { start, end };
  }

  private pipeWithCleanup(
    stream: NodeJS.ReadableStream,
    response: Response,
  ): void {
    response.on("close", () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    });
    stream.pipe(response);
  }

  private async assertCanPost(user?: User): Promise<User> {
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }

    const postRole = (await this.system.getSetting(
      SystemSettingName.PostNewsRole,
      "administrator",
    )) as e_player_roles_enum;

    if (!isRoleAbove(user.role, postRole)) {
      throw new ForbiddenException(
        "You do not have permission to post news",
      );
    }

    return user;
  }
}
