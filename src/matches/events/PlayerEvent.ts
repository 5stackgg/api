import MatchEventProcessor from "./abstracts/MatchEventProcessor";
import {
  players_constraint,
  players_update_column,
} from "../../../generated/zeus";

export default class PlayerEvent extends MatchEventProcessor<{
  steam_id: string;
  player_name: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_players_one: [
        {
          object: {
            name: this.data.player_name,
            steam_id: this.data.steam_id,
          },
          on_conflict: {
            constraint: players_constraint.players_steam_id_key,
            update_columns: [players_update_column.name],
          },
        },
        {
          __typename: true,
        },
      ],
    });
  }
}
