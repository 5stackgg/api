import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class PlayerDisconnected extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    // Leaving during warmup has to clear this, or a lobby someone walked out of
    // still looks full: the match would be force started without them, and
    // they'd dodge the no-show penalty on cancellation.
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
            is_connected: false,
          },
        },
        affected_rows: true,
      },
    });

    await this.chat.leaveLobbyViaGame(this.matchId, this.data.steam_id);
  }
}
