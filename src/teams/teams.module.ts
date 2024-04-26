import { Module } from "@nestjs/common";
import { TeamsController } from "./teams.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [HasuraModule],
  controllers: [TeamsController],
  providers: [loggerFactory()],
})
export class TeamsModule {}
