import { forwardRef, Module } from "@nestjs/common";
import { loggerFactory } from "../utilities/LoggerFactory";
import { MatchmakingGateway } from "./matchmaking.gateway";
import { HasuraModule } from "src/hasura/hasura.module";
import { RedisModule } from "src/redis/redis.module";
import { MatchesModule } from "src/matches/matches.module";
import { MatchmakeService } from "./matchmake.service";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullModule } from "@nestjs/bullmq";
import { getQueuesProcessors } from "src/utilities/QueueProcessors";
import { MatchmakingQueues } from "./enums/MatchmakingQueues";
import { CancelMatchMaking } from "./jobs/CancelMatchMaking";

@Module({
  imports: [
    RedisModule,
    HasuraModule,
    forwardRef(() => MatchesModule),
    BullModule.registerQueue({
      name: MatchmakingQueues.Matchmaking,
    }),
    BullBoardModule.forFeature({
      name: MatchmakingQueues.Matchmaking,
      adapter: BullMQAdapter,
    }),
  ],
  exports: [MatchmakeService, MatchmakingLobbyService],
  providers: [
    MatchmakingGateway,
    MatchmakeService,
    MatchmakingLobbyService,
    CancelMatchMaking,
    ...getQueuesProcessors("Matchmaking"),
    loggerFactory(),
  ],
})
export class MatchMaking {}
