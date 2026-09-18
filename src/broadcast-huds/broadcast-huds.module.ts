import { Module } from "@nestjs/common";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { PostgresModule } from "src/postgres/postgres.module";
import { S3Module } from "src/s3/s3.module";
import { BroadcastHudsController } from "./broadcast-huds.controller";
import { BroadcastHudsService } from "./broadcast-huds.service";

@Module({
  imports: [PostgresModule, S3Module],
  controllers: [BroadcastHudsController],
  providers: [BroadcastHudsService, loggerFactory()],
  exports: [BroadcastHudsService],
})
export class BroadcastHudsModule {}
