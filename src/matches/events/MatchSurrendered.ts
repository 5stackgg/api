import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class MatchSurrendered extends MatchEventProcessor<{
  winning_lineup_id: string;
}> {
  public async process() {
    try {
      await this.hasura.mutation({
        update_matches_by_pk: {
          __args: {
            pk_columns: {
              id: this.matchId,
            },
            _set: {
              status: "Surrendered",
              winning_lineup_id: this.data.winning_lineup_id,
            },
          },
          __typename: true,
        },
      });
    } catch (error) {
      console.error("Error updating match status", error);
    }
  }
}
