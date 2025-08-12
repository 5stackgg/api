import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import { HasuraService } from "../../hasura/hasura.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { Logger } from "@nestjs/common";
import { ChatService } from "../../chat/chat.service";

export default class MatchMapResetRoundEvent extends MatchEventProcessor<{
  round: string;
  match_map_id: string;
}> {
  constructor(
    logger: Logger,
    hasura: HasuraService,
    matchAssistant: MatchAssistantService,
    chat: ChatService,
  ) {
    super(logger, hasura, matchAssistant, chat);
  }

  public async process() {
    const statsRound = parseInt(this.data.round);

    const { match_map_rounds } = await this.hasura.query({
      match_map_rounds: {
        __args: {
          where: {
            round: {
              _gte: statsRound,
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


    const deletedAt = new Date();

    await this.hasura.mutation({
      update_player_kills: {
        __args: {
          where: {
            round: {
              _gte: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: deletedAt,
          },
        },
        __typename: true,
      },
      update_player_assists: {
        __args: {
          where: {
            round: {
              _gte: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: deletedAt,
          },
        },
        __typename: true,
      },
      update_player_damages: {
        __args: {
          where: {
            round: {
              _gte: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: deletedAt,
          },
        },
        __typename: true,
      },
      update_player_flashes: {
        __args: {
          where: {
            round: {
              _gte: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: deletedAt,
          },
        },
        __typename: true,
      },
      update_player_utility: {
        __args: {
          where: {
            round: {
              _gte: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: deletedAt,
          },
        },
        __typename: true,
      },
      update_player_objectives: {
        __args: {
          where: {
            round: {
              _gte: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: deletedAt,
          },
        },
        __typename: true,
      },
      update_player_unused_utility: {
        __args: {
          where: {
            round: {
              _gte: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: deletedAt,
          },
        },
        __typename: true,
      },
    });

    for (const match_map_round of match_map_rounds) {
      if (match_map_round.round === statsRound) {
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

      if (match_map_round.round < statsRound) {
        continue;
      }

      await this.hasura.mutation({
        update_match_map_rounds_by_pk: {
          __args: {
            pk_columns: {
              id: match_map_round.id,
            },
            _set: {
              deleted_at: deletedAt,
            },
          },
          __typename: true,
        },
      });
    }

    this.logger.warn(
      `deleted ${match_map_rounds.length} rounds from match: ${this.matchId}`,
    );

    await this.matchAssistant.restoreMatchRound(this.matchId, statsRound);
  }
}
