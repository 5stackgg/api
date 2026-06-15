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
  private externalClient: Client;

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

    this.externalClient = new Client({
      port: 443,
      endPoint: process.env.DEMOS_DOMAIN,
      useSSL: true,
      accessKey: this.config.key,
      secretKey: this.config.secret,
    });
  }

  public get bucketName(): string {
    return this.bucket;
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

  public listStream(
    prefix: string = "",
    recursive: boolean = true,
    bucket: string = this.bucket,
  ) {
    return this.client.listObjects(bucket, prefix, recursive);
  }

  public async get(
    filename: string,
    bucket: string = this.bucket,
  ): Promise<Readable> {
    return await this.client.getObject(bucket, filename);
  }

  public async getPartial(
    filename: string,
    offset: number,
    length: number,
    bucket: string = this.bucket,
  ): Promise<Readable> {
    return await this.client.getPartialObject(bucket, filename, offset, length);
  }

  public async readPrefix(
    filename: string,
    length: number,
    bucket: string = this.bucket,
  ): Promise<Buffer> {
    const stream = await this.getPartial(filename, 0, length, bucket);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  public async put(
    filename: string,
    stream: Readable | Buffer,
    bucket: string = this.bucket,
  ): Promise<void> {
    await this.client.putObject(bucket, filename, stream);
  }

  public async copyObject(
    fromKey: string,
    toKey: string,
    bucket: string = this.bucket,
  ): Promise<void> {
    await this.client.copyObject(bucket, toKey, `/${bucket}/${fromKey}`);
  }

  public async stat(filename: string, bucket: string = this.bucket) {
    return await this.client.statObject(bucket, filename);
  }

  public async removePrefix(
    prefix: string,
    bucket: string = this.bucket,
  ): Promise<number> {
    const entries: Array<{ name: string; versionId?: string }> = [];
    const stream = this.client.listObjects(bucket, prefix, true, {
      IncludeVersion: true,
    });

    for await (const obj of stream) {
      const info = obj as { name?: string; versionId?: string };
      if (!info.name) {
        continue;
      }
      entries.push(
        info.versionId && info.versionId !== "null"
          ? { name: info.name, versionId: info.versionId }
          : { name: info.name },
      );
    }

    let removed = 0;
    for (let i = 0; i < entries.length; i += 1000) {
      const batch = entries.slice(i, i + 1000);
      await this.client.removeObjects(bucket, batch);
      removed += batch.length;
    }
    return removed;
  }

  public async removeKeys(
    keys: string[],
    bucket: string = this.bucket,
  ): Promise<number> {
    let removed = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.removeObjects(bucket, batch);
      removed += batch.length;
    }
    return removed;
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

    const client =
      !useLocal && this.config.endpoint === "minio"
        ? this.externalClient
        : this.client;

    if (type === "put") {
      presignedUrl = await client.presignedPutObject(bucket, key, expires);
    } else {
      presignedUrl = await client.presignedGetObject(bucket, key, expires);
    }

    return presignedUrl;
  }

  public async createMultipartUpload(
    key: string,
    bucket: string = this.bucket,
  ): Promise<string> {
    return await this.client.initiateNewMultipartUpload(bucket, key, {});
  }

  public async getPresignedPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expires = 60 * 60 * 6,
    bucket: string = this.bucket,
  ): Promise<string> {
    const client =
      this.config.endpoint === "minio" ? this.externalClient : this.client;

    return await client.presignedUrl("PUT", bucket, key, expires, {
      uploadId,
      partNumber: partNumber.toString(),
    });
  }

  public async completeMultipartUpload(
    key: string,
    uploadId: string,
    bucket: string = this.bucket,
  ): Promise<void> {
    const parts = await (
      this.client as unknown as {
        listParts: (
          bucket: string,
          key: string,
          uploadId: string,
        ) => Promise<Array<{ part: number; etag: string }>>;
      }
    ).listParts(bucket, key, uploadId);
    if (parts.length === 0) {
      throw new Error("no parts uploaded");
    }
    await this.client.completeMultipartUpload(
      bucket,
      key,
      uploadId,
      parts
        .sort((a, b) => a.part - b.part)
        .map((part) => ({ part: part.part, etag: part.etag })),
    );
  }

  public async abortMultipartUpload(
    key: string,
    uploadId: string,
    bucket: string = this.bucket,
  ): Promise<void> {
    await this.client.abortMultipartUpload(bucket, key, uploadId);
  }
}
