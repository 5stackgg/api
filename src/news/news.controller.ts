import { Controller } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HasuraAction } from "../hasura/hasura.controller";
import { SystemService } from "src/system/system.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { NewsQueues } from "./enums/NewsQueues";
import { ScrapeTldrNews } from "./jobs/ScrapeTldrNews";

@Controller("news")
export class NewsController {
  constructor(
    private readonly system: SystemService,
    @InjectQueue(NewsQueues.ScrapeTldrNews) private readonly scrapeQueue: Queue,
  ) {}

  @HasuraAction()
  public async rescanTldrNews() {
    const enabled = await this.system.getSetting(
      SystemSettingName.TldrNewsEnabled,
      false,
    );

    if (!enabled) {
      throw Error("tl;dr news integration is not enabled");
    }

    await this.scrapeQueue.add(
      ScrapeTldrNews.name,
      { force: true },
      {
        jobId: "tldr-news.manual",
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    return { success: true };
  }
}
