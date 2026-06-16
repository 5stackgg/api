import { WorkerHost } from "@nestjs/bullmq";
import { DemoQueues } from "../enums/DemoQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { DemoReparseService } from "../demo-reparse.service";

@UseQueue("Demos", DemoQueues.ReparseAll, { concurrency: 1 })
export class ReparseAllDemos extends WorkerHost {
  constructor(private readonly demoReparse: DemoReparseService) {
    super();
  }

  async process(): Promise<void> {
    await this.demoReparse.runReparseAll();
  }
}
