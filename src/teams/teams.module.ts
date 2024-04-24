import { Module } from "@nestjs/common";
import { TeamsController } from "./teams.controller";
import { HasuraModule } from "../hasura/hasura.module";

@Module({
  imports: [HasuraModule],
  controllers: [TeamsController],
  providers: [],
})
export class TeamsModule {}
