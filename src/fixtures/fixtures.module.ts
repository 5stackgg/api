import { Module } from "@nestjs/common";
import { FixturesController } from "./fixtures.controller";
import { PostgresModule } from "src/postgres/postgres.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { TypeSenseModule } from "../type-sense/type-sense.module";
import { BullModule } from "@nestjs/bullmq";
import { TypesenseQueues } from "../type-sense/enums/TypesenseQueues";

@Module({
  imports: [
    PostgresModule,
    TypeSenseModule,
    BullModule.registerQueue({
      name: TypesenseQueues.TypeSense,
    }),
  ],
  controllers: [FixturesController],
  providers: [loggerFactory()],
})
export class FixturesModule {}
