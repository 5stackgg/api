import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  Logger,
  MaxFileSizeValidator,
  NotFoundException,
  Param,
  ParseFilePipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { HasuraEvent } from "../hasura/hasura.controller";
import { signUploadToken } from "../steam-match-history/uploadToken";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { S3Service } from "../s3/s3.service";
import { User } from "../auth/types/User";
import { EventsService } from "./events.service";

const IMAGE_MAX_SIZE = 10 * 1024 * 1024;
const VIDEO_MAX_SIZE = 512 * 1024 * 1024;
const AUDIO_MAX_SIZE = 50 * 1024 * 1024;
// Anything at or under this posts through the API exactly like avatars and
// news images. Only bigger files (long mp4s) need the multipart bypass —
// Cloudflare caps proxied request bodies at ~100MB and times slow ones out.
const DIRECT_MAX_SIZE = 90 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 64 * 1024 * 1024;

const EXTENSION_BY_MIMETYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
};

const MAX_SIZE_BY_MIMETYPE: Record<string, { maxSize: number; label: string }> =
  {
    "image/png": { maxSize: IMAGE_MAX_SIZE, label: "10MB" },
    "image/jpeg": { maxSize: IMAGE_MAX_SIZE, label: "10MB" },
    "image/webp": { maxSize: IMAGE_MAX_SIZE, label: "10MB" },
    "image/gif": { maxSize: IMAGE_MAX_SIZE, label: "10MB" },
    "video/mp4": { maxSize: VIDEO_MAX_SIZE, label: "512MB" },
    "audio/mpeg": { maxSize: AUDIO_MAX_SIZE, label: "50MB" },
  };

const MULTIPART_MEDIA: Record<
  string,
  { mimeType: string; maxSize: number; label: string }
> = {
  mp4: { mimeType: "video/mp4", maxSize: VIDEO_MAX_SIZE, label: "512MB" },
};

// Static "events/media" prefix (rather than "events" + "media" in each route)
// so the panel ingress can expose exactly this path and nothing else that may
// ever be added under /events.
@Controller("events/media")
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly s3: S3Service,
    private readonly logger: Logger,
  ) {}

  @Post(":eventId/upload")
  @UseInterceptors(FileInterceptor("file"))
  public async uploadMedia(
    @Param("eventId") eventId: string,
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: DIRECT_MAX_SIZE }),
          new FileTypeValidator({
            fileType: /(image\/(png|jpeg|webp|gif)|video\/mp4|audio\/mpeg)/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = await this.assertCanUpload(
      eventId,
      request.user as User | undefined,
    );

    // ParseFilePipe applies the shared 90MB ceiling; per-type caps and (for
    // audio/video, whose mimetype is client-claimed) magic bytes go here.
    const cap = MAX_SIZE_BY_MIMETYPE[file.mimetype];
    if (!cap) {
      throw new BadRequestException("unsupported file type");
    }
    if (file.size > cap.maxSize) {
      throw new BadRequestException(`file exceeds ${cap.label} limit`);
    }
    if (
      !file.mimetype.startsWith("image/") &&
      !this.hasValidMagicBytes(file.buffer.subarray(0, 12), file.mimetype)
    ) {
      throw new BadRequestException("file content does not match its type");
    }

    const extension = EXTENSION_BY_MIMETYPE[file.mimetype] || "png";
    const filename = this.eventsService.generateFilename(extension);
    await this.s3.put(
      this.eventsService.mediaKey(eventId, filename),
      file.buffer,
      file.mimetype,
    );

    const id = await this.eventsService.saveMedia({
      eventId,
      uploaderSteamId: user.steam_id,
      filename,
      mimeType: file.mimetype,
      size: file.size,
      title: this.eventsService.titleFromFilename(file.originalname),
    });

    return { success: true, id, filename };
  }

  // Poster frame for a video item, captured client-side by the uploader at
  // upload time so viewers never download the mp4 for a gallery tile.
  @Post(":eventId/:mediaId/thumbnail")
  @UseInterceptors(FileInterceptor("file"))
  public async uploadThumbnail(
    @Param("eventId") eventId: string,
    @Param("mediaId") mediaId: string,
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 3 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = await this.assertCanUpload(
      eventId,
      request.user as User | undefined,
    );
    if (!/^[0-9a-fA-F-]{36}$/.test(mediaId)) {
      throw new NotFoundException("media not found");
    }
    const media = await this.eventsService.getMediaById(eventId, mediaId);
    if (!media) {
      throw new NotFoundException("media not found");
    }
    if (
      media.uploader_steam_id !== user.steam_id &&
      !(await this.eventsService.isOrganizer(eventId, user))
    ) {
      throw new ForbiddenException(
        "only the uploader or an organizer can set the thumbnail",
      );
    }

    const extension = EXTENSION_BY_MIMETYPE[file.mimetype] || "webp";
    const thumbnailFilename = this.eventsService.generateFilename(extension);
    await this.s3.put(
      this.eventsService.mediaKey(eventId, thumbnailFilename),
      file.buffer,
      file.mimetype,
    );
    await this.eventsService.setMediaThumbnail(media, thumbnailFilename);
    return { success: true, filename: thumbnailFilename };
  }

  @Post(":eventId/initiate")
  public async initiateUpload(
    @Param("eventId") eventId: string,
    @Req() request: Request,
    @Body() body: { fileName?: string; fileSize?: number },
  ): Promise<{
    uploadId: string;
    key: string;
    chunkSize: number;
    parts: Array<{ partNumber: number; url: string }>;
  }> {
    const user = await this.assertCanUpload(
      eventId,
      request.user as User | undefined,
    );

    const extension = (body.fileName ?? "").toLowerCase().split(".").pop();
    const media = extension ? MULTIPART_MEDIA[extension] : undefined;
    if (!media) {
      throw new BadRequestException("expected an .mp4 file");
    }

    const fileSize = Number(body.fileSize);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      throw new BadRequestException("invalid file size");
    }
    if (fileSize <= DIRECT_MAX_SIZE) {
      // Small files must use the plain upload endpoint (same path as
      // avatars/news); the multipart bypass exists only for bodies too big
      // to proxy through Cloudflare.
      throw new BadRequestException("file is small enough to upload directly");
    }
    if (fileSize > media.maxSize) {
      throw new BadRequestException(`file exceeds ${media.label} limit`);
    }

    const filename = this.eventsService.generateFilename(extension);
    const key = this.eventsService.mediaKey(eventId, filename);
    const uploadId = await this.s3.createMultipartUpload(key);
    const partCount = Math.ceil(fileSize / UPLOAD_CHUNK_SIZE);
    const workerUrl = await this.eventsService.getCloudflareWorkerUrl();

    // Cloudflare-worker deployments (B2-backed storage) must route part PUTs
    // through the worker: it answers the CORS preflight and signs the B2
    // write itself. Each part URL carries a short-lived HMAC token bound to
    // this key+uploadId so the worker never signs arbitrary writes (same
    // scheme as the demo upload flow).
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
      `event media initiate steam_id=${user.steam_id} key=${key} parts=${partCount} bytes=${fileSize}`,
    );

    return { uploadId, key, chunkSize: UPLOAD_CHUNK_SIZE, parts };
  }

  @Post(":eventId/complete")
  public async completeUpload(
    @Param("eventId") eventId: string,
    @Req() request: Request,
    @Body() body: { uploadId?: string; key?: string; fileName?: string },
  ): Promise<{ success: boolean; id: string; filename: string }> {
    const user = await this.assertCanUpload(
      eventId,
      request.user as User | undefined,
    );
    const { key, filename, media } = this.assertEventKey(eventId, body.key);
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

    // The size cap on /initiate trusts the client-claimed fileSize, so
    // enforce the real assembled size here — presigned part PUTs aren't capped.
    const { size } = await this.s3.stat(key);
    if (size > media.maxSize) {
      await this.s3.remove(key);
      throw new BadRequestException(`file exceeds ${media.label} limit`);
    }

    const header = await this.s3.readPrefix(key, 12);
    if (!this.hasValidMagicBytes(header, media.mimeType)) {
      await this.s3.remove(key);
      throw new BadRequestException("file content does not match its type");
    }

    const id = await this.eventsService.saveMedia({
      eventId,
      uploaderSteamId: user.steam_id,
      filename,
      mimeType: media.mimeType,
      size,
      title: this.eventsService.titleFromFilename(body.fileName),
    });

    this.logger.log(
      `event media complete steam_id=${user.steam_id} key=${key}`,
    );

    return { success: true, id, filename };
  }

  @Post(":eventId/abort")
  public async abortUpload(
    @Param("eventId") eventId: string,
    @Req() request: Request,
    @Body() body: { uploadId?: string; key?: string },
  ): Promise<{ success: boolean }> {
    await this.assertCanUpload(eventId, request.user as User | undefined);
    const { key } = this.assertEventKey(eventId, body.key);
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

  @Get(":eventId/:filename")
  public async serveMedia(
    @Param("eventId") eventId: string,
    @Param("filename") filename: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (
      !/^[0-9a-fA-F-]{36}$/.test(eventId) ||
      !/^[A-Za-z0-9._-]+$/.test(filename)
    ) {
      throw new NotFoundException("media not found");
    }

    // 404 (not 403) when the viewer lacks access, so probing a URL never
    // confirms that a Private event exists at that id.
    const canView = await this.eventsService.canView(
      eventId,
      request.user as User | undefined,
    );
    if (!canView) {
      throw new NotFoundException("media not found");
    }

    const media = await this.eventsService.getMedia(eventId, filename);
    if (!media) {
      throw new NotFoundException("media not found");
    }

    await this.stream(
      this.eventsService.mediaKey(eventId, filename),
      media.is_thumbnail ? "image/webp" : media.mime_type,
      request,
      response,
    );
  }

  @Delete(":eventId/:mediaId")
  public async deleteMedia(
    @Param("eventId") eventId: string,
    @Param("mediaId") mediaId: string,
    @Req() request: Request,
  ): Promise<{ success: boolean }> {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("authentication required");
    }
    if (
      !/^[0-9a-fA-F-]{36}$/.test(eventId) ||
      !/^[0-9a-fA-F-]{36}$/.test(mediaId)
    ) {
      throw new NotFoundException("media not found");
    }

    const media = await this.eventsService.getMediaById(eventId, mediaId);
    if (!media) {
      throw new NotFoundException("media not found");
    }

    if (
      media.uploader_steam_id !== user.steam_id &&
      !(await this.eventsService.isOrganizer(eventId, user))
    ) {
      throw new ForbiddenException(
        "only the uploader or an organizer can delete media",
      );
    }

    await this.eventsService.deleteMedia(media);
    return { success: true };
  }

  @HasuraEvent()
  public async events(data: HasuraEventData<{ id: string }>) {
    if (data.op === "DELETE" && data.old?.id) {
      await this.eventsService.removeEventMedia(data.old.id);
    }
  }

  private async assertCanUpload(eventId: string, user?: User): Promise<User> {
    if (!user) {
      throw new ForbiddenException("authentication required");
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(eventId)) {
      throw new NotFoundException("event not found");
    }

    const canUpload = await this.eventsService.canUpload(eventId, user);
    if (canUpload === null) {
      throw new NotFoundException("event not found");
    }
    if (!canUpload) {
      throw new ForbiddenException(
        "you do not have permission to upload media to this event",
      );
    }
    return user;
  }

  private assertEventKey(
    eventId: string,
    key?: string,
  ): {
    key: string;
    filename: string;
    media: { mimeType: string; maxSize: number; label: string };
  } {
    const expectedPrefix = `${EventsService.MEDIA_PREFIX}/${eventId}/`;
    if (
      !key ||
      !key.startsWith(expectedPrefix) ||
      !/^[a-zA-Z0-9/_-]+\.mp4$/.test(key)
    ) {
      throw new BadRequestException("invalid upload key");
    }
    const filename = key.slice(expectedPrefix.length);
    if (filename.includes("/")) {
      throw new BadRequestException("invalid upload key");
    }
    const extension = filename.split(".").pop() as string;
    return { key, filename, media: MULTIPART_MEDIA[extension] };
  }

  private hasValidMagicBytes(header: Buffer, mimeType: string): boolean {
    if (mimeType === "video/mp4") {
      return header.length >= 8 && header.subarray(4, 8).toString() === "ftyp";
    }
    // MP3: ID3v2 tag or a bare MPEG frame sync (0xFFEx).
    return (
      (header.length >= 3 && header.subarray(0, 3).toString() === "ID3") ||
      (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0)
    );
  }

  private async stream(
    key: string,
    contentType: string,
    request: Request,
    response: Response,
  ) {
    let stat;
    try {
      stat = await this.s3.stat(key);
    } catch (error) {
      if ((error as { code?: string })?.code === "NotFound") {
        response.status(404).json({ error: "not found" });
        return;
      }
      this.logger.error(`failed to stat ${key}: ${(error as Error)?.message}`);
      response.status(500).json({ error: "internal" });
      return;
    }

    const size = stat.size;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Accept-Ranges", "bytes");
    // Image mimetypes are client-claimed at upload (only audio/video get
    // magic-byte checks), so forbid content sniffing on the way back out.
    response.setHeader("X-Content-Type-Options", "nosniff");
    // Filenames are immutable but event visibility is not: never allow
    // shared caches to hold media for an event that may go Private later.
    response.setHeader("Cache-Control", "private, max-age=3600");

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
        const stream = await this.s3.getPartial(key, range.start, length);
        this.pipeWithCleanup(stream, response);
      } else {
        response.status(200);
        response.setHeader("Content-Length", String(size));
        const stream = await this.s3.get(key);
        this.pipeWithCleanup(stream, response);
      }
    } catch (error) {
      this.logger.error(
        `failed to stream ${key}: ${(error as Error)?.message}`,
      );
      if (!response.headersSent) {
        response.status(500).json({ error: "internal" });
      } else {
        response.destroy();
      }
    }
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

  private pipeWithCleanup(stream: NodeJS.ReadableStream, response: Response) {
    response.on("close", () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    });
    stream.pipe(response);
  }
}
