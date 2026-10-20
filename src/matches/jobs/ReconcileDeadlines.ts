import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { DeadlinesService } from "../deadlines/deadlines.service";

@UseQueue("Matches", MatchQueues.Deadlines)
export class ReconcileDeadlines extends WorkerHost {
  constructor(private readonly deadlines: DeadlinesService) {
    super();
  }

  async process(): Promise<void> {
    await this.deadlines.reconcile();
  }
}
