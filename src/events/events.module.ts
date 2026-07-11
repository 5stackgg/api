import { Module } from "@nestjs/common";
import { PostgresModule } from "src/postgres/postgres.module";
import { S3Module } from "src/s3/s3.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { EventsService } from "./events.service";
import { EventsController } from "./events.controller";

@Module({
  imports: [PostgresModule, S3Module],
  controllers: [EventsController],
  providers: [EventsService, loggerFactory()],
  exports: [EventsService],
})
export class EventsModule {}
