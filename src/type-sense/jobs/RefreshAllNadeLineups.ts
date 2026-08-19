import { WorkerHost } from "@nestjs/bullmq";
import { TypesenseQueues } from "../enums/TypesenseQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { TypeSenseService } from "../type-sense.service";

// Its own queue, like the player rebuild: a full library reindex is minutes
// of paging and would otherwise sit in front of every single-lineup refresh.
@UseQueue("TypeSense", TypesenseQueues.NadeLineupReindex, { concurrency: 1 })
export class RefreshAllNadeLineupsJob extends WorkerHost {
  constructor(private readonly typeSense: TypeSenseService) {
    super();
  }

  async process(): Promise<void> {
    await this.typeSense.reindexNadeLineups();
  }
}
