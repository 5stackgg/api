import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class MatchMapResetRoundEvent extends MatchEventProcessor<{
  round: string;
  match_map_id: string;
}> {
  public async process() {
    const statsRound = parseInt(this.data.round);

    // Rush's map script owns the round state, so its only reset is replaying
    // the map from warmup, and only while that map is still being played.
    if ((await this.matchAssistant.getMatchType(this.matchId)) === "Rush") {
      if (statsRound > 0) {
        this.logger.warn(
          `[${this.matchId}] ignoring reset to round ${statsRound}: Rush matches only reset to round 0`,
        );
        return;
      }

      const { match_maps_by_pk: matchMap } = await this.hasura.query({
        match_maps_by_pk: {
          __args: {
            id: this.data.match_map_id,
          },
          status: true,
        },
      });

      if (!["Live", "Overtime", "Paused"].includes(matchMap?.status)) {
        this.logger.warn(
          `[${this.matchId}] ignoring Rush reset: match map ${this.data.match_map_id} is ${matchMap?.status}, not in play`,
        );
        return;
      }
    }

    this.logger.log(
      `[${this.matchId}] marking round ${statsRound + 1} for deletion from match map: ${this.data.match_map_id}`,
    );

    await this.hasura.mutation({
      update_player_kills: {
        __args: {
          where: {
            round: {
              _gt: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: null,
          },
        },
        __typename: true,
      },
      update_player_assists: {
        __args: {
          where: {
            round: {
              _gt: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: null,
          },
        },
        __typename: true,
      },
      update_player_damages: {
        __args: {
          where: {
            round: {
              _gt: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: null,
          },
        },
        __typename: true,
      },
      update_player_flashes: {
        __args: {
          where: {
            round: {
              _gt: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: null,
          },
        },
        __typename: true,
      },
      update_player_utility: {
        __args: {
          where: {
            round: {
              _gt: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: null,
          },
        },
        __typename: true,
      },
      update_player_objectives: {
        __args: {
          where: {
            round: {
              _gt: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: null,
          },
        },
        __typename: true,
      },
      update_player_unused_utility: {
        __args: {
          where: {
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: null,
          },
        },
        __typename: true,
      },
    });

    const deletedAt = new Date();

    await this.hasura.mutation({
      update_player_kills: {
        __args: {
          where: {
            round: {
              _gt: statsRound,
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
              _gt: statsRound,
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
              _gt: statsRound,
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
              _gt: statsRound,
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
              _gt: statsRound,
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
              _gt: statsRound,
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
              _gt: statsRound,
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

    await this.hasura.mutation({
      update_match_map_rounds: {
        __args: {
          where: {
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
          _set: {
            deleted_at: null,
          },
        },
        __typename: true,
      },
    });

    const { match_map_rounds } = await this.hasura.query({
      match_map_rounds: {
        __args: {
          where: {
            round: {
              _gt: statsRound,
            },
            match_map_id: {
              _eq: this.data.match_map_id,
            },
          },
        },
        id: true,
        round: true,
        lineup_1_timeouts_available: true,
        lineup_2_timeouts_available: true,
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

      if (match_map_round.round <= statsRound) {
        continue;
      }
      this.logger.log(
        `[${this.matchId}] marking round ${match_map_round.round} for deletion from match map: ${this.data.match_map_id}`,
      );

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

    this.logger.log(
      `[${this.matchId}] stats reset for round ${statsRound} complete, requesting server round restore`,
    );

    await this.matchAssistant.restoreMatchRound(this.matchId, statsRound);
  }
}
