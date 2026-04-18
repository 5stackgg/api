import { Module } from "@nestjs/common";
import { TrophiesService } from "./trophies.service";
import { TrophiesController } from "./trophies.controller";
import { S3Module } from "../s3/s3.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [S3Module, PostgresModule],
  providers: [TrophiesService, loggerFactory()],
  controllers: [TrophiesController],
})
export class TrophiesModule {}
