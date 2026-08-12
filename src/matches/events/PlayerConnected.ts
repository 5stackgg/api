import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class PlayerConnected extends MatchEventProcessor<{
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
    // Marks them as present. Cleared again on disconnect, so this always means
    // "in the server right now" -- which is what both the force-start check and
    // the no-show penalty on cancellation read.
    await this.hasura.mutation({
      update_match_lineup_players: {
        __args: {
          where: {
            steam_id: {
              _eq: this.data.steam_id,
            },
            lineup: {
              match_id: {
                _eq: this.matchId,
              },
            },
          },
          _set: {
            is_connected: true,
          },
        },
        affected_rows: true,
      },
    });

    await this.chat.joinLobbyViaGame(this.matchId, this.data.steam_id);
  }
}
