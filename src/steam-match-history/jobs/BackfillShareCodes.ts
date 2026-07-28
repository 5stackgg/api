import { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "src/utilities/QueueProcessors";
import { SteamMatchHistoryQueues } from "../enums/SteamMatchHistoryQueues";
import { SteamMatchHistoryService } from "../steam-match-history.service";

export type BackfillShareCodesPayload = {
  steam_id: string;
  from_share_code: string;
};

// Serialized: the walk is one Steam Web API call per match with a delay
// between them, and Steam rate limits the endpoint hard.
@UseQueue("SteamMatchHistory", SteamMatchHistoryQueues.BackfillShareCodes, {
  concurrency: 1,
  limiter: { max: 2, duration: 60_000 },
})
export class BackfillShareCodes extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly steamMatchHistory: SteamMatchHistoryService,
  ) {
    super();
  }

  async process(job: Job<BackfillShareCodesPayload>): Promise<void> {
    const { steam_id, from_share_code } = job.data;

    const { walked, healed, error } =
      await this.steamMatchHistory.backfillShareCodes(
        steam_id,
        from_share_code,
      );

    this.logger.log(
      `backfill-share-codes done steam_id=${steam_id} walked=${walked} healed=${healed}${error ? ` error=${error}` : ""}`,
    );
  }
}
