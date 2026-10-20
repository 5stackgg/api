import { forwardRef, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { Queue } from "bullmq";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { MatchesModule } from "../matches/matches.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import {
  getQueuesProcessors,
  scheduleJobs,
} from "../utilities/QueueProcessors";
import { ScrimQueues } from "./enums/ScrimQueues";
import { ScrimsService } from "./scrims.service";
import { ScrimsController } from "./scrims.controller";
import { TeamCalendarController } from "./team-calendar.controller";
import { MatchScrims } from "./jobs/MatchScrims";
import { MatchScrimTeam } from "./jobs/MatchScrimTeam";
import { ExpireScrimRequests } from "./jobs/ExpireScrimRequests";
import { SuggestTeams } from "./jobs/SuggestTeams";

@Module({
  imports: [
    HasuraModule,
    PostgresModule,
    ConfigModule,
    NotificationsModule,
    forwardRef(() => MatchesModule),
    BullModule.registerQueue({
      name: ScrimQueues.ScrimMatcher,
    }),
    BullBoardModule.forFeature({
      name: ScrimQueues.ScrimMatcher,
      adapter: BullMQAdapter,
    }),
  ],
  providers: [
    ScrimsService,
    MatchScrims,
    MatchScrimTeam,
    ExpireScrimRequests,
    SuggestTeams,
    ...getQueuesProcessors("Scrims"),
    loggerFactory(),
  ],
  controllers: [ScrimsController, TeamCalendarController],
  exports: [ScrimsService],
})
export class ScrimsModule {
  constructor(@InjectQueue(ScrimQueues.ScrimMatcher) scrimMatcherQueue: Queue) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void scheduleJobs(scrimMatcherQueue, {
      [MatchScrims.name]: { pattern: "37 * * * *" },
      [SuggestTeams.name]: { pattern: "0 6 * * *" },
    });

    // At boot as well as hourly: it is what arms the window openings due before
    // the next run, which Redis may no longer hold.
    void scrimMatcherQueue.add(
      MatchScrims.name,
      {},
      { removeOnComplete: true, removeOnFail: true },
    );
  }
}
