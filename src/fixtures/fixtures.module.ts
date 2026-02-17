import { Module } from "@nestjs/common";
import { FixturesController } from "./fixtures.controller";
import { PostgresModule } from "src/postgres/postgres.module";
import { loggerFactory } from "src/utilities/LoggerFactory";

@Module({
  imports: [PostgresModule],
  controllers: [FixturesController],
  providers: [loggerFactory()],
})
export class FixturesModule {}
