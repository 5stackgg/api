import { Job, Queue } from "bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue, wakeJobAt } from "../../utilities/QueueProcessors";
import { ScrimQueues } from "../enums/ScrimQueues";
import { ScrimsService } from "../scrims.service";

@UseQueue("Scrims", ScrimQueues.ScrimMatcher)
export class MatchScrimTeam extends WorkerHost {
  constructor(private readonly scrims: ScrimsService) {
    super();
  }

  public static async wake(
    queue: Queue,
    teamId: string,
    at: Date | number = Date.now(),
  ) {
    await wakeJobAt(queue, MatchScrimTeam.name, at, {
      key: teamId,
      data: { teamId },
    });
  }

  async process(job: Job<{ teamId: string }>): Promise<void> {
    if (!(await this.scrims.isFinderEnabled())) {
      return;
    }

    await this.scrims.runScrimAlerts({ teamId: job.data.teamId });
    await this.scrims.matchTeams([job.data.teamId]);
  }
}
