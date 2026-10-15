import { Module } from "@nestjs/common";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { SystemModule } from "src/system/system.module";
import { S3Module } from "src/s3/s3.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { NotificationsModule } from "src/notifications/notifications.module";
import { RedisModule } from "src/redis/redis.module";
import { PlayerBlocksModule } from "src/player-blocks/player-blocks.module";
import { NewsService } from "./news.service";
import { NewsController } from "./news.controller";
import { NewsCommentsService } from "./news-comments.service";
import { NewsCommentsController } from "./news-comments.controller";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    SystemModule,
    S3Module,
    NotificationsModule,
    RedisModule,
    PlayerBlocksModule,
  ],
  controllers: [NewsController, NewsCommentsController],
  providers: [NewsService, NewsCommentsService, loggerFactory()],
  exports: [NewsService],
})
export class NewsModule {}
