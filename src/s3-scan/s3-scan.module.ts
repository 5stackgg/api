import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { S3Module } from "src/s3/s3.module";
import { AuthModule } from "src/auth/auth.module";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { NotificationsModule } from "src/notifications/notifications.module";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { loggerFactory } from "../utilities/LoggerFactory";
import { S3ScanQueues } from "./enums/S3ScanQueues";
import { S3ScanService } from "./s3-scan.service";
import { S3ScanController } from "./s3-scan.controller";
import { ScanOrphanedObjects } from "./jobs/ScanOrphanedObjects";

@Module({
  imports: [
    S3Module,
    AuthModule,
    HasuraModule,
    PostgresModule,
    NotificationsModule,
    BullModule.registerQueue({
      name: S3ScanQueues.Scan,
    }),
    BullBoardModule.forFeature({
      name: S3ScanQueues.Scan,
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [S3ScanController],
  providers: [
    S3ScanService,
    ScanOrphanedObjects,
    ...getQueuesProcessors("S3Scan"),
    loggerFactory(),
  ],
  exports: [S3ScanService],
})
export class S3ScanModule {}
