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
import { getQueuesProcessors } from "../utilities/QueueProcessors";
import { ScrimQueues } from "./enums/ScrimQueues";
import { ScrimsService } from "./scrims.service";
import { ScrimsController } from "./scrims.controller";
import { TeamCalendarController } from "./team-calendar.controller";
import { MatchScrims } from "./jobs/MatchScrims";
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
    SuggestTeams,
    ...getQueuesProcessors("Scrims"),
    loggerFactory(),
  ],
  controllers: [ScrimsController, TeamCalendarController],
  exports: [ScrimsService],
})
export class ScrimsModule {
  constructor(
    @InjectQueue(ScrimQueues.ScrimMatcher) scrimMatcherQueue: Queue,
  ) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void scrimMatcherQueue.add(
      MatchScrims.name,
      {},
      {
        repeat: {
          pattern: "* * * * *",
        },
      },
    );

    void scrimMatcherQueue.add(
      SuggestTeams.name,
      {},
      {
        repeat: {
          pattern: "0 6 * * *",
        },
      },
    );
  }
}
