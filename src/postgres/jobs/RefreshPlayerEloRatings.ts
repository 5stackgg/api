import { WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { PostgresService } from "../../postgres/postgres.service";
import { PostgresQueues } from "../enums/PostgresQueues";
import { UseQueue } from "../../utilities/QueueProcessors";

// Stored elo follows the active season, which changes as a season starts or
// ends with nothing written (hasura/functions/players/player_elo_ratings.sql).
@UseQueue("Postgres", PostgresQueues.Postgres)
export class RefreshPlayerEloRatings extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const [{ rebuilt }] = await this.postgres.query<
      Array<{ rebuilt: boolean }>
    >("SELECT public.refresh_player_elo_ratings_if_stale() AS rebuilt");

    if (rebuilt) {
      this.logger.log("rebuilt every player's stored elo");
    }
  }
}
