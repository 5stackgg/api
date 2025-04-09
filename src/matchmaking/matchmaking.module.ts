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
import { MatchmakingController } from "./matchmaking.controller";
import { HasuraService } from "src/hasura/hasura.service";
import { EloCalculation } from "./jobs/EloCalculation";
import { Queue } from "bullmq";
import { InjectQueue } from "@nestjs/bullmq";
import { PostgresService } from "src/postgres/postgres.service";

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
    EloCalculation,
    PostgresService,
    ...getQueuesProcessors("Matchmaking"),
    loggerFactory(),
  ],
  controllers: [MatchmakingController],
})
export class MatchMaking {
  constructor(
    private readonly hasuraService: HasuraService,
    @InjectQueue(MatchmakingQueues.Matchmaking) private queue: Queue,
  ) {
    void this.generatePlayerRatings();
  }

  async generatePlayerRatings() {
    const { player_elo_aggregate } = await this.hasuraService.query({
      player_elo_aggregate: {
        aggregate: {
          count: true,
        }
      },
    });

    if (player_elo_aggregate.aggregate.count > 0) {
      // return;
    }

    const matches = await this.hasuraService.query({
      matches: {
        id: true
      },
    });

    for (const match of matches.matches) {
      await this.queue.add(
        EloCalculation.name,
        {
          matchId: match.id,
        },
      );
    }
  }
}
