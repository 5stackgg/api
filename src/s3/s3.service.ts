import { Client } from "minio";
import { Readable } from "stream";
import { Request } from "express";
import { ConfigService } from "@nestjs/config";
import { S3Config } from "../configs/types/S3Config";
import { Injectable, Logger } from "@nestjs/common";
import { ObjectInfo } from "minio/dist/main/internal/type";

@Injectable()
export class S3Service {
  private client: Client;
  private directClient?: Client;
  private bucket: string;
  private config: S3Config;

  constructor(
    private readonly logger: Logger,
    private readonly configService: ConfigService,
  ) {
    this.config = this.configService.get("s3");

    this.bucket = this.config.bucket;
    this.client = new Client({
      port: parseInt(this.config.port),
      endPoint: this.config.endpoint,
      useSSL: this.config.useSSL,
      accessKey: this.config.key,
      secretKey: this.config.secret,
    });

    // Initialize direct client if configured
    if (this.config.directEndpoint) {
      this.directClient = new Client({
        port: parseInt(this.config.directPort || "443"),
        endPoint: this.config.directEndpoint,
        useSSL: this.config.directUseSSL !== false,
        accessKey: this.config.key,
        secretKey: this.config.secret,
      });
    }
  }

  public multerStorage(
    uploadPath: (request: Request, file: Express.Multer.File) => string,
  ) {
    return {
      _handleFile: async (
        request: Request,
        file: Express.Multer.File,
        callback: (error?: string, file?: Express.Multer.File) => void,
      ) => {
        try {
          // TODO - somehow we still leak memory
          await this.put(uploadPath(request, file), file.stream);

          request.file = file;

          callback(null, file);
        } catch (error) {
          callback(error);
        }
      },
      _removeFile: async (
        request: Request,
        file: Express.Multer.File,
        callback: (error?: string) => void,
      ) => {
        try {
          await this.remove(uploadPath(request, file));
          callback();
        } catch (error) {
          callback(error);
        }
      },
    };
  }

  public async list(bucket: string = this.bucket): Promise<ObjectInfo[]> {
    return await this.client.listObjects(bucket).toArray();
  }

  public async get(
    filename: string,
    bucket: string = this.bucket,
  ): Promise<Readable> {
    return await this.client.getObject(bucket, filename);
  }

  public async put(
    filename: string,
    stream: Readable | Buffer,
    bucket: string = this.bucket,
  ): Promise<void> {
    await this.client.putObject(bucket, filename, stream);
  }

  public async stat(filename: string, bucket: string = this.bucket) {
    return await this.client.statObject(bucket, filename);
  }

  public async remove(
    filename: string,
    bucket: string = this.bucket,
  ): Promise<boolean> {
    try {
      await this.client.removeObject(bucket, filename);
    } catch (error) {
      if (error.code === "NoSuchKey") {
        return false;
      }
      this.logger.error("unable to remove", error.code);
      return false;
    }
    return true;
  }

  public async has(
    filepath: string,
    bucket: string = this.bucket,
  ): Promise<boolean> {
    try {
      return !!(await this.client.statObject(bucket, filepath));
    } catch (error) {
      if (error.code === "NotFound") {
        return false;
      }
      throw error;
    }
  }

  public getClientEndpoint() {
    return `${this.config.endpoint}:${this.config.port}`;
  }

  public async getPresignedUrl(
    key: string,
    bucket: string = this.bucket,
    // 5 minutes
    expires = 60 * 5,
    type: "put" | "get" = "put",
  ) {
    let presignedUrl: string;

    if (type === "put") {
      presignedUrl = await this.client.presignedPutObject(bucket, key, expires);
    } else {
      presignedUrl = await this.client.presignedGetObject(bucket, key, expires);
    }

    return presignedUrl;
  }

  /**
   * Get presigned URL for direct upload (bypasses CloudFlare)
   */
  public async getDirectPresignedUrl(
    key: string,
    bucket: string = this.bucket,
    expires = 60 * 5,
    type: "put" | "get" = "put",
  ) {
    if (!this.directClient) {
      throw new Error("Direct client not configured. Set S3_DIRECT_ENDPOINT environment variable.");
    }

    let presignedUrl: string;
    if (type === "put") {
      presignedUrl = await this.directClient.presignedPutObject(bucket, key, expires);
    } else {
      presignedUrl = await this.directClient.presignedGetObject(bucket, key, expires);
    }

    return presignedUrl;
  }

  /**
   * Determine if direct upload should be used based on file size
   */
  public shouldUseDirectUpload(fileSize?: number): boolean {
    const FILE_SIZE_THRESHOLD = 50 * 1024 * 1024; // 50MB threshold
    return !!(this.directClient && (!fileSize || fileSize > FILE_SIZE_THRESHOLD));
  }

  /**
   * Get the appropriate presigned URL based on file size
   */
  public async getAppropriatePresignedUrl(
    key: string,
    fileSize?: number,
    bucket: string = this.bucket,
    expires = 60 * 5,
    type: "put" | "get" = "put",
  ) {
    const useDirectUpload = this.shouldUseDirectUpload(fileSize);
    
    if (useDirectUpload) {
      this.logger.log(`Using direct upload for large file: ${key} (${fileSize} bytes)`);
      return {
        url: await this.getDirectPresignedUrl(key, bucket, expires, type),
        method: "direct" as const,
      };
    } else {
      return {
        url: await this.getPresignedUrl(key, bucket, expires, type),
        method: "cloudflare" as const,
      };
    }
  }
}
