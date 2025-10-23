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

  public async getPresignedUrl(
    key: string,
    bucket: string = this.bucket,
    // 5 minutes
    expires = 60 * 5,
    type: "put" | "get" = "put",
    useLocal: boolean = false,
  ) {
    let presignedUrl: string;

    if (type === "put") {
      presignedUrl = await this.client.presignedPutObject(bucket, key, expires);
    } else {
      presignedUrl = await this.client.presignedGetObject(bucket, key, expires);
    }

    if (!useLocal && this.config.endpoint === "minio") {
      presignedUrl = presignedUrl.replace(
        `http://minio:9000`,
        `https://${process.env.DEMOS_DOMAIN}`,
      );
    }

    return presignedUrl;
  }
}
