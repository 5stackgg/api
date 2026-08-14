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
            // Only refill name for a player who hasn't been through
            // registerName/approveNameChange -- otherwise every connect
            // reverts a deliberately chosen, admin-approved name back to
            // whatever Steam persona the game server reports.
            //
            // name_registered is nullable with no default, so most rows are
            // NULL. A bare _eq: false would evaluate to NULL and update
            // nothing, silently ending name refresh for everyone.
            where: {
              _or: [
                { name_registered: { _is_null: true } },
                { name_registered: { _eq: false } },
              ],
            },
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
