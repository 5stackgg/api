import { Module } from "@nestjs/common";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { HasuraModule } from "src/hasura/hasura.module";
import { PostgresModule } from "src/postgres/postgres.module";
import { SystemModule } from "src/system/system.module";
import { loggerFactory } from "src/utilities/LoggerFactory";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { NewsQueues } from "./enums/NewsQueues";
import { NewsService } from "./news.service";
import { NewsController } from "./news.controller";
import { ScrapeTldrNews } from "./jobs/ScrapeTldrNews";

@Module({
  imports: [
    BullModule.registerQueue({
      name: NewsQueues.ScrapeTldrNews,
    }),
    BullBoardModule.forFeature({
      name: NewsQueues.ScrapeTldrNews,
      adapter: BullMQAdapter,
    }),
    HasuraModule,
    PostgresModule,
    SystemModule,
  ],
  controllers: [NewsController],
  providers: [
    NewsService,
    ScrapeTldrNews,
    ...getQueuesProcessors("News"),
    loggerFactory(),
  ],
  exports: [NewsService],
})
export class NewsModule {
  constructor(
    @InjectQueue(NewsQueues.ScrapeTldrNews)
    queue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      ScrapeTldrNews.name,
      {},
      {
        repeat: {
          pattern: "0 * * * *",
          jobId: ScrapeTldrNews.name,
        },
      },
    );
  }
}
