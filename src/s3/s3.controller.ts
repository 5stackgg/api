import { HasuraAction } from "src/hasura/hasura.controller";
import { S3Service } from "src/s3/s3.service";
import { Controller, Logger } from "@nestjs/common";
import fetch from "node-fetch";

@Controller()
export class S3Controller {
  constructor(
    private readonly s3: S3Service,
    private readonly logger: Logger,
  ) {}

  @HasuraAction()
  public async testUpload() {
    if (await this.s3.has("hello.txt")) {
      await this.s3.remove("hello.txt");
    }

    try {
      const data = `world : ${new Date().toISOString()}`;
      const putResponse = await fetch(
        await this.s3.getPresignedUrl("hello.txt"),
        {
          method: "PUT",
          body: Buffer.from(data),
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": data.length.toString(),
          },
        },
      );

      if (!putResponse.ok) {
        this.logger.error(
          `Failed to upload file to S3: ${putResponse.statusText}`,
        );
        throw new Error(putResponse.statusText);
      }

      return {};
    } catch (error) {
      this.logger.error(`Failed to upload file to S3: ${error.message}`);
      return {
        error: error.message,
      };
    }
  }

  @HasuraAction()
  public async getTestUploadLink() {
    try {
      const data = await fetch(
        await this.s3.getPresignedUrl("hello.txt", undefined, 60, "get"),
      );

      return {
        link: await this.s3.getPresignedUrl("hello.txt", undefined, 60, "get"),
      };
    } catch (error) {
      this.logger.error(`Failed to get presigned URL: ${error.message}`);
      return {
        error: error.message,
      };
    }
  }
}
