import { InjectQueue, WorkerHost } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { UseQueue, wakeJobAt } from "../../utilities/QueueProcessors";
import { ScrimQueues } from "../enums/ScrimQueues";
import { ScrimsService } from "../scrims.service";
import { MatchScrimTeam } from "./MatchScrimTeam";
import { ExpireScrimRequests } from "./ExpireScrimRequests";

// The hourly backstop. Postings, availability and requests each wake the teams
// they touch (ScrimsController), and every window opening is armed here ahead
// of time, so this only catches what moved without a row changing -- team
// ranks drifting -- and anything whose wake-up was lost.
@UseQueue("Scrims", ScrimQueues.ScrimMatcher)
export class MatchScrims extends WorkerHost {
  // Past the next run, so a window opening is armed before it is due.
  public static readonly LOOKAHEAD_MS = 75 * 60 * 1000;

  constructor(
    private readonly scrims: ScrimsService,
    @InjectQueue(ScrimQueues.ScrimMatcher) private readonly queue: Queue,
  ) {
    super();
  }

  async process(): Promise<void> {
    const now = new Date();
    const until = new Date(now.getTime() + MatchScrims.LOOKAHEAD_MS);

    await this.scrims.expireStaleRequests();
    for (const at of await this.scrims.openRequestExpiries(until)) {
      await wakeJobAt(this.queue, ExpireScrimRequests.name, at);
    }

    if (!(await this.scrims.isFinderEnabled())) {
      return;
    }

    await this.scrims.runScrimAlerts();
    await this.scrims.matchTeams();

    for (const { teamId, at } of await this.scrims.scrimWindowOpenings(
      now,
      until,
    )) {
      await MatchScrimTeam.wake(this.queue, teamId, at);
    }
  }
}
