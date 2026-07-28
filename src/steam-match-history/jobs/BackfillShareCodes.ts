import { Job, Queue } from "bullmq";
import { Logger } from "@nestjs/common";
import { InjectQueue, WorkerHost } from "@nestjs/bullmq";
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
    @InjectQueue(SteamMatchHistoryQueues.BackfillShareCodes)
    private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<BackfillShareCodesPayload>): Promise<void> {
    const { steam_id, from_share_code } = job.data;

    const { walked, healed, error, lastShareCode, exhausted } =
      await this.steamMatchHistory.backfillShareCodes(
        steam_id,
        from_share_code,
      );

    this.logger.log(
      `backfill-share-codes steam_id=${steam_id} walked=${walked} healed=${healed} exhausted=${exhausted}${error ? ` error=${error}` : ""}`,
    );

    // Hit the per-run cap with chain left: continue from where we stopped
    // rather than making an operator re-run it, and never from the original
    // seed — every code re-walked is another rate-limited Steam call.
    if (!exhausted && !error && walked > 0 && lastShareCode) {
      await this.queue.add(
        BackfillShareCodes.name,
        { steam_id, from_share_code: lastShareCode },
        {
          jobId: `backfill-share-codes-${steam_id}`,
          attempts: 1,
          removeOnComplete: true,
        },
      );
    }
  }
}
