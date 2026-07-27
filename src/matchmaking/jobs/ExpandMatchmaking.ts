import { Job } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { e_match_types_enum } from "generated";
import { MatchmakingQueues } from "../enums/MatchmakingQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchmakeService } from "src/matchmaking/matchmake.service";

@UseQueue("Matchmaking", MatchmakingQueues.Matchmaking)
export class ExpandMatchmaking extends WorkerHost {
  constructor(private readonly matchmaking: MatchmakeService) {
    super();
  }

  async process(
    job: Job<{
      type: e_match_types_enum;
      region: string;
    }>,
  ): Promise<void> {
    const { type, region } = job.data;
    await this.matchmaking.matchmake(type, region);
  }
}
