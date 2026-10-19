import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class MatchMapResetRoundEvent extends MatchEventProcessor<{
  round: string;
  match_map_id: string;
}> {
  public async process() {
    const statsRound = parseInt(this.data.round);

    // Rush's map script owns the round state, so its only reset is replaying
    // the map from warmup.
    if (
      (await this.matchAssistant.getMatchType(this.matchId)) === "Rush" &&
      statsRound > 0
    ) {
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

    // A backup is only loaded on a live map. Before warmup and knife are over,
    // CS2 restarts the game again when the map goes live, which would wipe the
    // restored round.
    if (!["Live", "Overtime", "Paused"].includes(matchMap?.status)) {
      this.logger.warn(
        `[${this.matchId}] ignoring reset to round ${statsRound}: match map ${this.data.match_map_id} is ${matchMap?.status}, not in play`,
      );
      return;
    }

    this.logger.log(
      `[${this.matchId}] resetting match map ${this.data.match_map_id} to round ${statsRound}, requesting server round restore`,
    );

    try {
      await this.matchAssistant.resetMatchMapToRound(
        this.data.match_map_id,
        statsRound,
      );
    } catch (error) {
      // The server resends an event until it is processed, so a refused round
      // has to be answered here or it would restore once that round is played.
      if ((error as { code?: string })?.code === "P0002") {
        this.logger.warn(
          `[${this.matchId}] not restoring round ${statsRound}: ${(error as Error).message}`,
        );
        return;
      }
      throw error;
    }

    await this.matchAssistant.restoreMatchRound(this.matchId, statsRound);
  }
}
