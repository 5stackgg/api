import { Client } from "minio";
import { Readable } from "stream";
import { Request } from "express";
import { ConfigService } from "@nestjs/config";
import { S3Config } from "../configs/types/S3Config";
import { Injectable, Logger } from "@nestjs/common";

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
      // endPoint: this.config.endpoint,
      // TODO - larger than 100 mb causes issues, unless i go within the cluster
      // TODO - thsi should be a proxy issue
      port: 9000,
      endPoint: "minio",
      useSSL: false,
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

  public async get(filename: string): Promise<Readable> {
    return await this.client.getObject(this.bucket, filename);
  }

  public async put(filename: string, stream: Readable | Buffer): Promise<void> {
    await this.client.putObject(this.bucket, filename, stream);
  }

  public async stat(filename: string) {
    return await this.client.statObject(this.bucket, filename);
  }

  public async remove(filename: string): Promise<boolean> {
    try {
      await this.client.removeObject(this.bucket, filename);
    } catch (error) {
      if (error.code === "NoSuchKey") {
        return false;
      }
      this.logger.error("unable to remove", error.code);
      return false;
    }
    return true;
  }

  public async has(filepath: string): Promise<boolean> {
    try {
      return !!(await this.client.statObject(this.bucket, filepath));
    } catch (error) {
      if (error.code === "NotFound") {
        return false;
      }
      throw error;
    }
  }
}
