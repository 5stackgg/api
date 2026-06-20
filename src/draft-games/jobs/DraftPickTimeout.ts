import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { DraftGameQueues } from "../enums/DraftGameQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { DraftService } from "../draft.service";

@UseQueue("DraftGames", DraftGameQueues.DraftGames)
export class DraftPickTimeout extends WorkerHost {
  constructor(private readonly draftService: DraftService) {
    super();
  }

  async process(
    job: Job<{
      draftGameId: string;
      pickCount: number;
    }>,
  ): Promise<void> {
    const { draftGameId, pickCount } = job.data;
    await this.draftService.autoPick(draftGameId, pickCount);
  }
}
