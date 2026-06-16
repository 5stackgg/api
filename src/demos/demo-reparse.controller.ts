import { Controller, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { HasuraAction } from "../hasura/hasura.controller";
import { DemoQueues } from "./enums/DemoQueues";
import { ReparseAllDemos } from "./jobs/ReparseAllDemos";
import { DemoReparseService } from "./demo-reparse.service";

@Controller("demo-reparse")
export class DemoReparseController {
  constructor(
    private readonly logger: Logger,
    private readonly demoReparse: DemoReparseService,
    @InjectQueue(DemoQueues.ReparseAll) private readonly reparseQueue: Queue,
  ) {}

  @HasuraAction()
  public async reparseAllDemos() {
    if (this.demoReparse.isRunning()) {
      return { success: true, running: true };
    }
    await this.reparseQueue.add(
      ReparseAllDemos.name,
      {},
      {
        jobId: ReparseAllDemos.name,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return { success: true, running: true };
  }

  @HasuraAction()
  public async cancelReparseAllDemos() {
    this.demoReparse.requestCancel();
    return { success: true };
  }

  @HasuraAction()
  public async reparseAllDemosStatus() {
    const status = await this.demoReparse.getStatus();
    return {
      running: status.running,
      canceled: status.canceled,
      started_at: status.started_at,
      finished_at: status.finished_at,
      total: status.total,
      completed: status.completed,
      failed: status.failed,
      current_demo_id: status.current_demo_id,
    };
  }
}
