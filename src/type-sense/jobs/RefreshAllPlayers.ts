import { WorkerHost } from "@nestjs/bullmq";
import { TypesenseQueues } from "../enums/TypesenseQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PlayerReindexService } from "../player-reindex.service";

@UseQueue("TypeSense", TypesenseQueues.PlayerReindex, { concurrency: 1 })
export class RefreshAllPlayersJob extends WorkerHost {
  constructor(private readonly reindex: PlayerReindexService) {
    super();
  }

  async process(): Promise<void> {
    await this.reindex.runReindexAll();
  }
}
