import { Module } from "@nestjs/common";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { SystemModule } from "src/system/system.module";
import { S3Module } from "src/s3/s3.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { NewsService } from "./news.service";
import { NewsController } from "./news.controller";

@Module({
  imports: [HasuraModule, PostgresModule, SystemModule, S3Module],
  controllers: [NewsController],
  providers: [NewsService, loggerFactory()],
  exports: [NewsService],
})
export class NewsModule {}
