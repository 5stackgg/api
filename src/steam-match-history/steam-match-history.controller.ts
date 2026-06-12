import { randomUUID } from "crypto";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { Request } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { User } from "../auth/types/User";
import { S3Service } from "../s3/s3.service";
import { SteamMatchHistoryQueues } from "./enums/SteamMatchHistoryQueues";
import { ProcessUploadedDemo } from "./jobs/ProcessUploadedDemo";
import { SteamMatchHistoryService } from "./steam-match-history.service";
import { signUploadToken } from "./uploadToken";

const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 64 * 1024 * 1024;
const UPLOAD_PREFIX = "demo-uploads";
const CS2_DEMO_MAGIC = Buffer.from([
  0x50, 0x42, 0x44, 0x45, 0x4d, 0x53, 0x32, 0x00,
]);

@Controller("steam-match-history")
export class SteamMatchHistoryController {
  constructor(
    private readonly service: SteamMatchHistoryService,
    private readonly logger: Logger,
    private readonly s3: S3Service,
    @InjectQueue(SteamMatchHistoryQueues.ProcessUploadedDemo)
    private readonly processUploadQueue: Queue,
  ) {}

  @Post("upload/initiate")
  @UseGuards(SteamGuard)
  public async initiateUpload(
    @Req() request: Request,
    @Body() body: { fileName?: string; fileSize?: number },
  ): Promise<{
    uploadId: string;
    key: string;
    chunkSize: number;
    parts: Array<{ partNumber: number; url: string }>;
  }> {
    const user = await this.assertCanUpload(request);

    const fileName = body.fileName ?? "";
    const fileSize = Number(body.fileSize);
    if (!fileName.toLowerCase().endsWith(".dem")) {
      throw new BadRequestException("expected a .dem file");
    }
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      throw new BadRequestException("invalid file size");
    }
    if (fileSize > MAX_UPLOAD_SIZE) {
      throw new BadRequestException("demo exceeds 2GB limit");
    }

    const key = `${UPLOAD_PREFIX}/${user.steam_id}/${randomUUID()}.dem`;
    const uploadId = await this.s3.createMultipartUpload(key);
    const partCount = Math.ceil(fileSize / UPLOAD_CHUNK_SIZE);
    const workerUrl = await this.service.getCloudflareWorkerUrl();

    // When uploads go through the Cloudflare worker (which signs the B2 PUT
    // with shared credentials) we must authorize each part write — otherwise
    // anyone reaching the worker with a valid uploadId could upload. Mint a
    // short-lived HMAC token bound to this key+uploadId; the worker verifies
    // it before signing. We key the HMAC on S3_SECRET — the worker already
    // shares the same B2 credential, so this needs no extra secret to manage.
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
      `demo upload initiate steam_id=${user.steam_id} key=${key} parts=${partCount} bytes=${fileSize}`,
    );

    return { uploadId, key, chunkSize: UPLOAD_CHUNK_SIZE, parts };
  }

  @Post("upload/complete")
  @UseGuards(SteamGuard)
  public async completeUpload(
    @Req() request: Request,
    @Body() body: { uploadId?: string; key?: string; fileName?: string },
  ): Promise<{ queued: boolean }> {
    const user = await this.assertCanUpload(request);
    const key = this.assertOwnedKey(user, body.key);
    if (!body.uploadId) {
      throw new BadRequestException("uploadId required");
    }

    try {
      await this.s3.completeMultipartUpload(key, body.uploadId);
    } catch (error) {
      try {
        await this.s3.abortMultipartUpload(key, body.uploadId);
      } catch (abortError) {
        this.logger.warn(`abort after failed complete key=${key}: ${abortError}`);
      }
      throw new BadRequestException(
        `could not assemble upload: ${(error as Error)?.message ?? error}`,
      );
    }

    // The size cap on /initiate is derived from the client-claimed fileSize, so
    // enforce the real assembled size here — presigned part PUTs aren't capped.
    const { size } = await this.s3.stat(key);
    if (size > MAX_UPLOAD_SIZE) {
      await this.s3.remove(key);
      throw new BadRequestException("demo exceeds 2GB limit");
    }

    const header = await this.s3.readPrefix(key, CS2_DEMO_MAGIC.length);
    if (!header.equals(CS2_DEMO_MAGIC)) {
      await this.s3.remove(key);
      throw new BadRequestException("not a valid CS2 demo file");
    }

    this.logger.log(`demo upload complete steam_id=${user.steam_id} key=${key}`);

    await this.processUploadQueue.add(
      ProcessUploadedDemo.name,
      {
        key,
        file_name: body.fileName ?? key,
        steam_id: user.steam_id,
      },
      {
        jobId: `process-upload-${key}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );

    return { queued: true };
  }

  @Post("upload/abort")
  @UseGuards(SteamGuard)
  public async abortUpload(
    @Req() request: Request,
    @Body() body: { uploadId?: string; key?: string },
  ): Promise<{ ok: boolean }> {
    const user = await this.assertCanUpload(request);
    const key = this.assertOwnedKey(user, body.key);
    if (!body.uploadId) {
      throw new BadRequestException("uploadId required");
    }
    try {
      await this.s3.abortMultipartUpload(key, body.uploadId);
    } catch (error) {
      this.logger.warn(`abort multipart upload failed key=${key}: ${error}`);
    }
    return { ok: true };
  }

  private async assertCanUpload(request: Request): Promise<User> {
    if (!request.user) {
      throw new ForbiddenException("authentication required");
    }
    if (request.user.role !== "administrator") {
      throw new ForbiddenException("administrator access required");
    }
    if (!(await this.service.isImportingAllowed())) {
      throw new ForbiddenException("external match imports are disabled");
    }
    return request.user;
  }

  private assertOwnedKey(user: User, key?: string): string {
    const expectedPrefix = `${UPLOAD_PREFIX}/${user.steam_id}/`;
    if (
      !key ||
      !key.startsWith(expectedPrefix) ||
      !/^[a-zA-Z0-9/_-]+\.dem$/.test(key)
    ) {
      throw new BadRequestException("invalid upload key");
    }
    return key;
  }

  @HasuraAction()
  public async linkSteamMatchHistory(data: {
    user: User;
    auth_code: string;
    share_code: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    if (!data.auth_code || !data.share_code) {
      throw new BadRequestException("auth_code and share_code required");
    }

    this.logger.log(
      `action linkSteamMatchHistory steam_id=${data.user.steam_id}`,
    );

    if (!this.service.isEnabled()) {
      return {
        success: false,
        error: "STEAM_WEB_API_KEY not configured on this 5stack instance",
      };
    }

    const result = await this.service.linkAccount(
      data.user.steam_id,
      data.auth_code,
      data.share_code,
    );
    return { success: result.ok, error: result.error };
  }

  @HasuraAction()
  public async unlinkSteamMatchHistory(data: {
    user: User;
  }): Promise<{ success: boolean }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    this.logger.log(
      `action unlinkSteamMatchHistory steam_id=${data.user.steam_id}`,
    );
    await this.service.unlinkAccount(data.user.steam_id);
    return { success: true };
  }

  @HasuraAction()
  public async pollSteamMatchHistory(data: {
    user: User;
  }): Promise<{ success: boolean; collected: number; error?: string }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    this.logger.log(
      `action pollSteamMatchHistory steam_id=${data.user.steam_id}`,
    );

    if (!this.service.isEnabled()) {
      return {
        success: false,
        collected: 0,
        error: "STEAM_WEB_API_KEY not configured",
      };
    }

    const result = await this.service.pollForUser(data.user.steam_id);
    return {
      success: !result.error,
      collected: result.collected,
      error: result.error ?? undefined,
    };
  }

  @HasuraAction()
  public async retryPendingMatchImport(data: {
    user: User;
    valve_match_id: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    if (!data.valve_match_id || !/^\d+$/.test(data.valve_match_id)) {
      throw new BadRequestException("invalid valve_match_id");
    }
    const result = await this.service.retryPendingImport(
      data.user.steam_id,
      data.valve_match_id,
    );
    return { success: result.ok, error: result.error };
  }

  @HasuraAction()
  public async clearPendingMatchImport(data: {
    user: User;
    valve_match_id: string;
  }): Promise<{ success: boolean }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    if (!data.valve_match_id || !/^\d+$/.test(data.valve_match_id)) {
      throw new BadRequestException("invalid valve_match_id");
    }
    const result = await this.service.clearPendingImport(
      data.user.steam_id,
      data.valve_match_id,
    );
    return { success: result.ok };
  }
}
