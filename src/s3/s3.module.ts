import { Module } from "@nestjs/common";
import { S3Service } from "./s3.service";
import { loggerFactory } from "../utilities/LoggerFactory";
import { S3Controller } from "./s3.controller";

@Module({
  exports: [S3Service],
  providers: [S3Service, loggerFactory()],
  controllers: [S3Controller],
})
export class S3Module {}
