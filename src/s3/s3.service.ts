import { Client } from "minio";
import { Readable } from "stream";
import { ConfigService } from "@nestjs/config";
import { S3Config } from "../config/types/S3Config";
import { Injectable } from "@nestjs/common";

@Injectable()
export class S3Service {
  private client: Client;
  private bucket: string;
  private config: S3Config;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.get("s3");

    this.bucket = this.config.bucket;
    this.client = new Client({
      endPoint: this.config.endpoint,
      accessKey: this.config.key,
      secretKey: this.config.secret,
    });
  }

  public async get(filename: string): Promise<Readable> {
    return await this.client.getObject(this.bucket, filename);
  }

  public async put(
    filename: string,
    stream: ReadableStream<Uint8Array>
  ): Promise<void> {
    await this.client.putObject(
      this.bucket,
      filename,
      (stream as unknown) as Readable
    );
  }

  public async remove(filename: string): Promise<boolean> {
    try {
      await this.client.removeObject(this.bucket, filename);
    } catch (error) {
      if (error.code === "NoSuchKey") {
        return false;
      }
      console.error("unable to remove", error.code);
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
