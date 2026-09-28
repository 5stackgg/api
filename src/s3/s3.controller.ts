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
        await this.s3.getPresignedUrl(
          "hello.txt",
          undefined,
          undefined,
          undefined,
          true,
        ),
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

  // Reads back the file testUpload wrote, the way a download is served: through
  // a presigned link. The browser can't do this itself, since most buckets
  // don't allow the panel's site to read them directly.
  @HasuraAction()
  public async testDownload() {
    try {
      const response = await fetch(
        await this.s3.getPresignedUrl("hello.txt", undefined, 60, "get"),
      );

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      if (!(await response.text()).startsWith("world")) {
        throw new Error(
          "the test file came back different from what was written",
        );
      }

      return {};
    } catch (error) {
      this.logger.error(`Failed to download file from S3: ${error.message}`);
      return {
        error: error.message,
      };
    }
  }

  @HasuraAction()
  public async getTestUploadLink() {
    try {
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
