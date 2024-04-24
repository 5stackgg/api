import { Module } from "@nestjs/common";
import { HasuraService } from "./hasura.service";
import { ActionsController } from "./actions/actions.controller";
import { EventsController } from "./events/events.controller";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { PostgresModule } from "../postgres/postgres.module";
import { HasuraMaintenanceJob } from "./jobs/HasuraMaintenanceJob";
import { Queue } from "bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HasuraQueues } from "./enums/HasuraQueues";

@Module({
  imports: [
    PostgresModule,
    BullModule.registerQueue({
      name: HasuraQueues.Hasura,
    }),
    BullBoardModule.forFeature({
      name: HasuraQueues.Hasura,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [HasuraService, HasuraMaintenanceJob],
  exports: [HasuraService],
  controllers: [ActionsController, EventsController],
})
export class HasuraModule {
  constructor(@InjectQueue(HasuraQueues.Hasura) private queue: Queue) {
    void queue.add(
      HasuraMaintenanceJob.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
        },
      }
    );
  }
}
