import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class TechTimeout extends MatchEventProcessor<{
  map_id: string;
  lineup_1_timeouts_available: number;
  lineup_2_timeouts_available: number;
}> {
  public async process() {
    await this.hasura.mutation({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: {
            id: this.data.map_id,
          },
          _set: {
            lineup_1_timeouts_available: this.data.lineup_1_timeouts_available,
            lineup_2_timeouts_available: this.data.lineup_2_timeouts_available,
          },
        },
      },
    });
  }
}
