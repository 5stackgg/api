import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class AntiWallhackStatusEvent extends MatchEventProcessor<{
  active: boolean;
}> {
  public async process() {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: this.matchId,
        },
        current_match_map_id: true,
      },
    });

    if (!match?.current_match_map_id) {
      return;
    }

    await this.hasura.mutation({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: {
            id: match.current_match_map_id,
          },
          _set: {
            anti_wallhack_active: this.data.active === true,
          },
        },
        id: true,
      },
    });
  }
}
