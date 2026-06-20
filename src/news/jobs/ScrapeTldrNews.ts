import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { NewsQueues } from "../enums/NewsQueues";
import { NewsService } from "../news.service";

@UseQueue("News", NewsQueues.ScrapeTldrNews)
export class ScrapeTldrNews extends WorkerHost {
  constructor(private readonly newsService: NewsService) {
    super();
  }

  async process(job: Job<{ force?: boolean }>): Promise<void> {
    await this.newsService.scrape(job.data?.force ?? false);
  }
}
