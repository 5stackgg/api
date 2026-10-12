import { WorkerHost } from "@nestjs/bullmq";
import { MatchmakingQueues } from "../enums/MatchmakingQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { MatchmakeService } from "src/matchmaking/matchmake.service";

@UseQueue("Matchmaking", MatchmakingQueues.Matchmaking)
export class HealStrandedLobbies extends WorkerHost {
  constructor(private readonly matchmaking: MatchmakeService) {
    super();
  }

  async process(): Promise<void> {
    await this.matchmaking.healStrandedLobbies();
  }
}
