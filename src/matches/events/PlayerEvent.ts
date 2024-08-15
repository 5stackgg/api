import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class PlayerEvent extends MatchEventProcessor<{
  steam_id: string;
  player_name: string;
}> {
  public async process() {
    await this.hasura.mutation({
      insert_players_one: {
        __args: {
          object: {
            name: this.data.player_name,
            steam_id: this.data.steam_id,
          },
          on_conflict: {
            constraint: "players_steam_id_key",
            update_columns: ["name"],
          },
        },
        __typename: true,
      },
    });
  }
}
