import { InjectQueue, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { PostgresService } from "../../postgres/postgres.service";
import { PostgresQueues } from "../enums/PostgresQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { TypesenseQueues } from "../../type-sense/enums/TypesenseQueues";
import { RefreshAllPlayersJob } from "../../type-sense/jobs/RefreshAllPlayers";

// Stored elo follows the active season, which changes as a season starts or
// ends with nothing written (hasura/functions/players/player_elo_ratings.sql).
@UseQueue("Postgres", PostgresQueues.Postgres)
export class RefreshPlayerEloRatings extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    @InjectQueue(TypesenseQueues.PlayerReindex)
    private readonly reindexQueue: Queue,
  ) {
    super();
  }

  async process(): Promise<void> {
    const [{ rebuilt }] = await this.postgres.query<
      Array<{ rebuilt: boolean }>
    >("SELECT public.refresh_player_elo_ratings_if_stale() AS rebuilt");

    if (rebuilt) {
      this.logger.log("rebuilt every player's stored elo");
      // The search index copies players.elo, and a rebuild writes no player_elo
      // row to send it an event.
      await this.reindexQueue.add(
        RefreshAllPlayersJob.name,
        {},
        {
          jobId: RefreshAllPlayersJob.name,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
  }
}
