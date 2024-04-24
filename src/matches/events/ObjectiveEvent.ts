import MatchEventProcessor from './abstracts/MatchEventProcessor';
import { e_objective_types_enum } from '../../../generated/zeus';

export default class ObjectiveEvent extends MatchEventProcessor<{
  time: string;
  round: number;
  player_steam_id: bigint;
  type: e_objective_types_enum;
  match_map_id: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_player_objectives_one: [
        {
          object: {
            time: new Date(this.data.time),
            match_id: this.matchId,
            match_map_id: this.data.match_map_id,
            type: this.data.type,
            round: this.data.round,
            player_steam_id: this.data.player_steam_id,
          },
        },
        {
          id: true,
        },
      ],
    });
  }
}
