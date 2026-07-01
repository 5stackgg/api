import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PlayerEloRecomputeService } from "../player-elo-recompute.service";

@UseQueue("Matches", MatchQueues.EloRecompute, { concurrency: 1 })
export class RecomputeAllElo extends WorkerHost {
  constructor(private readonly eloRecompute: PlayerEloRecomputeService) {
    super();
  }

  async process(): Promise<void> {
    await this.eloRecompute.runRecomputeAll();
  }
}
