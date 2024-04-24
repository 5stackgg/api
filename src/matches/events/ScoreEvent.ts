import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import {
  match_map_rounds_constraint,
  match_map_rounds_update_column,
} from "../../../generated/zeus";

export default class ScoreEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  match_map_id: number;
  lineup_1_score: number;
  lineup_1_money: number;
  lineup_1_timeouts_available: number;
  lineup_2_score: number;
  lineup_2_money: number;
  lineup_2_timeouts_available: number;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_match_map_rounds_one: [
        {
          object: {
            time: new Date(this.data.time),
            round: this.data.round,
            match_map_id: this.data.match_map_id,
            lineup_1_score: this.data.lineup_1_score,
            lineup_1_money: this.data.lineup_1_money,
            lineup_1_timeouts_available: this.data.lineup_1_timeouts_available,

            lineup_2_score: this.data.lineup_2_score,
            lineup_2_money: this.data.lineup_2_money,
            lineup_2_timeouts_available: this.data.lineup_2_timeouts_available,
          },
          on_conflict: {
            constraint:
              match_map_rounds_constraint.match_rounds_match_id_round_key,
            update_columns: [
              match_map_rounds_update_column.lineup_1_score,
              match_map_rounds_update_column.lineup_1_money,
              match_map_rounds_update_column.lineup_1_timeouts_available,
              match_map_rounds_update_column.lineup_2_score,
              match_map_rounds_update_column.lineup_2_money,
              match_map_rounds_update_column.lineup_2_timeouts_available,
            ],
          },
        },
        {
          id: true,
        },
      ],
    });
  }
}
