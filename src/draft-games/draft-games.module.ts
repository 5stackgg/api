import { forwardRef, Module } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { loggerFactory } from "../utilities/LoggerFactory";
import { HasuraModule } from "src/hasura/hasura.module";
import { RedisModule } from "src/redis/redis.module";
import { CacheModule } from "src/cache/cache.module";
import { ChatModule } from "src/chat/chat.module";
import { MatchesModule } from "src/matches/matches.module";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { DraftGameQueues } from "./enums/DraftGameQueues";
import { DraftGamesController } from "./draft-games.controller";
import { DraftGameService } from "./draft-game.service";
import { DraftService } from "./draft.service";
import { DraftMatchService } from "./draft-match.service";
import { DraftPickTimeout } from "./jobs/DraftPickTimeout";
import { CleanExpiredDraftGames } from "./jobs/CleanExpiredDraftGames";

@Module({
  imports: [
    RedisModule,
    HasuraModule,
    CacheModule,
    ChatModule,
    forwardRef(() => MatchesModule),
    BullModule.registerQueue({
      name: DraftGameQueues.DraftGames,
    }),
    BullBoardModule.forFeature({
      name: DraftGameQueues.DraftGames,
      adapter: BullMQAdapter,
    }),
  ],
  exports: [DraftGameService],
  controllers: [DraftGamesController],
  providers: [
    DraftGameService,
    DraftService,
    DraftMatchService,
    DraftPickTimeout,
    CleanExpiredDraftGames,
    ...getQueuesProcessors("DraftGames"),
    loggerFactory(),
  ],
})
export class DraftGamesModule {
  constructor(@InjectQueue(DraftGameQueues.DraftGames) queue: Queue) {
    if (process.env.RUN_MIGRATIONS) {
      return;
    }

    void queue.add(
      CleanExpiredDraftGames.name,
      {},
      { repeat: { pattern: "* * * * *" } },
    );
  }
}
