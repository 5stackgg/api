import { Module } from "@nestjs/common";
import { TournamentsController } from "./tournaments.controller";
import { loggerFactory } from "../utilities/LoggerFactory";
import { TournamentsService } from "./tournaments.service";
import { HasuraModule } from "../hasura/hasura.module";

@Module({
  imports: [HasuraModule],
  controllers: [TournamentsController],
  providers: [loggerFactory(), TournamentsService],
})
export class TournamentsModule {}
