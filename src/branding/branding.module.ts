import { Module } from "@nestjs/common";
import { BrandingService } from "./branding.service";
import { BrandingController } from "./branding.controller";
import { S3Module } from "../s3/s3.module";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [S3Module, HasuraModule],
  providers: [BrandingService, loggerFactory()],
  controllers: [BrandingController],
})
export class BrandingModule {}
