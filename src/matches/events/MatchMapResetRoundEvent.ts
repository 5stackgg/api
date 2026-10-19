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
      `[${this.matchId}] resetting match map ${this.data.match_map_id} to round ${statsRound}, requesting server round restore`,
    );

    await this.matchAssistant.resetMatchMapToRound(
      this.data.match_map_id,
      statsRound,
    );

    await this.matchAssistant.restoreMatchRound(this.matchId, statsRound);
  }
}
