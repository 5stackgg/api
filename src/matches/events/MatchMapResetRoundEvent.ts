import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { HasuraService } from "../../hasura/hasura.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { S3Service } from "../../s3/s3.service";
import { Logger } from "@nestjs/common";

export default class MatchMapResetRoundEvent extends MatchEventProcessor<{
  round: string;
  match_map_id: string;
}> {
  constructor(
    logger: Logger,
    hasura: HasuraService,
    matchAssistant: MatchAssistantService,
    private readonly s3: S3Service,
  ) {
    super(logger, hasura, matchAssistant);
  }

  public async process() {
    const round = parseInt(this.data.round) + 1;

    const { match_map_rounds } = await this.hasura.query({
      match_map_rounds: {
        __args: {
          where: {
            round: {
              _gte: round,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        id: true,
        round: true,
        backup_file: true,
        lineup_1_timeouts_available: true,
        lineup_2_timeouts_available: true,
      },
    });

    for (const match_map_round of match_map_rounds) {
      if (match_map_round.round === round) {
        await this.hasura.mutation({
          update_match_maps_by_pk: {
            __args: {
              pk_columns: {
                id: this.data.match_map_id,
              },
              _set: {
                lineup_1_timeouts_available:
                  match_map_round.lineup_1_timeouts_available,
                lineup_2_timeouts_available:
                  match_map_round.lineup_2_timeouts_available,
              },
            },
            __typename: true,
          },
        });
      }

      try {
        await this.s3.remove(match_map_round.backup_file);
      } catch (error) {
        this.logger.warn("unable to delete backup round", error);
      }

      await this.hasura.mutation({
        delete_match_map_rounds_by_pk: {
          __args: {
            id: match_map_round.id,
          },
          __typename: true,
        },
      });
    }

    this.logger.warn(
      `deleted ${match_map_rounds.length} rounds from match: ${this.matchId}`,
    );

    await this.matchAssistant.restoreMatchRound(this.matchId, round);
  }
}
