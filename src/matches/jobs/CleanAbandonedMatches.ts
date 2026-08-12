import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { HasuraService } from "../../hasura/hasura.service";

@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class CleanAbandonedMatches extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
  ) {
    super();
  }
  // Matchmaking cooldown forgives an abandon after a week, but it windows the
  // rows by date rather than relying on them being gone. The record itself is
  // kept far longer because elo reads it: generate_player_elo_for_match applies
  // the leaver penalty from this table, so deleting a row at a week silently
  // changes what a recompute or season backfill produces for that match.
  private static readonly RETENTION_DAYS = 365;

  async process(): Promise<number> {
    const cutoff = new Date(
      Date.now() -
        1000 * 60 * 60 * 24 * CleanAbandonedMatches.RETENTION_DAYS,
    );

    const { delete_abandoned_matches } = await this.hasura.mutation({
      delete_abandoned_matches: {
        __args: {
          where: {
            abandoned_at: {
              _lt: cutoff,
            },
          },
        },
        affected_rows: true,
      },
    });

    if (delete_abandoned_matches.affected_rows > 0) {
      this.logger.log(
        `${delete_abandoned_matches.affected_rows} abandoned matches deleted`,
      );
    }

    return delete_abandoned_matches.affected_rows;
  }
}
