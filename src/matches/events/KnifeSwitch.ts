import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class KnifeSwitch extends MatchEventProcessor<void> {
  public async process() {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: this.matchId,
        },
        current_match_map_id: true,
        match_maps: {
          id: true,
          lineup_1_side: true,
          lineup_2_side: true,
        },
      },
    });

    const currentMap = match.match_maps.find((match_map) => {
      return match_map.id === match.current_match_map_id;
    });

    await this.hasura.mutation({
      update_match_maps_by_pk: {
        __args: {
          pk_columns: {
            id: match.current_match_map_id,
          },
          _set: {
            lineup_1_side: currentMap.lineup_2_side,
            lineup_2_side: currentMap.lineup_1_side,
          },
        },
        __typename: true,
      },
    });

    await this.matchAssistant.sendServerMatchId(this.matchId);
  }
}
