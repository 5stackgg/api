import MatchEventProcessor from './abstracts/MatchEventProcessor';

export default class CaptainEvent extends MatchEventProcessor<{
  claim: boolean;
  steam_id: string;
  player_name: string;
}> {
  public async process() {
    const match = await this.matchAssistant.getMatchLineups(this.matchId);

    const lineup_player = match.lineup_players.find((lineup_player) => {
      if (lineup_player.steam_id) {
        return lineup_player.steam_id.toString() === this.data.steam_id;
      }
      return lineup_player.player.name.startsWith(this.data.player_name);
    });

    if (!lineup_player) {
      return;
    }

    await this.hasura.mutation({
      update_match_lineup_players: [
        {
          where: {
            [lineup_player.steam_id ? "steam_id" : "discord_id"]: {
              _eq: lineup_player.steam_id || lineup_player.discord_id,
            },
          },
          _set: {
            captain: this.data.claim,
          },
        },
        {
          __typename: true,
        },
      ],
    });
  }
}
