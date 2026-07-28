import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { MatchImportService } from "../match-import.service";

export type SyncMatchPartiesPayload = {
  match_id: string;
};

// Serialized and rate limited on purpose: every run is a round trip to the
// Steam GC or the FACEIT match room, and a reparse-all can enqueue one of
// these per match.
@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.SyncMatchParties, {
  concurrency: 1,
  limiter: { max: 20, duration: 60_000 },
})
export class SyncMatchParties extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly matchImport: MatchImportService,
  ) {
    super();
  }

  async process(job: Job<SyncMatchPartiesPayload>): Promise<void> {
    const { match_id } = job.data;

    // Parties are supplementary: a match with none is a normal outcome (all
    // solo queuers), not a failure to retry.
    const stamped = await this.matchImport.syncPartiesForMatch(match_id);
    if (stamped === 0) {
      this.logger.debug(`sync-match-parties ${match_id}: no parties`);
    }
  }
}
