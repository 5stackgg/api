import { Module } from "@nestjs/common";
import { TournamentsController } from "./tournaments.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { S3Module } from "../s3/s3.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule, S3Module],
  controllers: [TournamentsController],
  providers: [loggerFactory()],
})
export class TournamentsModule {}
