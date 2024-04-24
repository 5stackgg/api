import { Module } from "@nestjs/common";
import { S3Service } from "./s3.service";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  exports: [S3Service],
  providers: [S3Service, loggerFactory()],
})
export class S3Module {}
