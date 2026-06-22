import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { DraftGameQueues } from "../enums/DraftGameQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("DraftGames", DraftGameQueues.DraftGames)
export class CleanExpiredDraftGames extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }

  async process(): Promise<number> {
    const { delete_draft_games } = await this.hasura.mutation({
      delete_draft_games: {
        __args: {
          where: {
            status: { _eq: "Open" },
            match_id: { _is_null: true },
            expires_at: { _lte: new Date() },
          },
        },
        affected_rows: true,
      },
    });

    if (delete_draft_games.affected_rows > 0) {
      this.logger.log(
        `removed ${delete_draft_games.affected_rows} expired draft games`,
      );
    }

    return delete_draft_games.affected_rows;
  }
}
