import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class CaptainEvent extends MatchEventProcessor<{
  claim: boolean;
  steam_id: string;
  player_name: string;
}> {
  public async process() {
    const match = await this.matchAssistant.getMatchLineups(this.matchId);

    if (!match) {
      return;
    }

    const lineup_player = match.lineup_players.find((lineup_player) => {
      if (lineup_player.steam_id) {
        return lineup_player.steam_id.toString() === this.data.steam_id;
      }

      if (lineup_player.player) {
        return lineup_player.player.name.startsWith(this.data.player_name);
      }

      return lineup_player.placeholder_name.startsWith(this.data.player_name);
    });

    if (!lineup_player) {
      return;
    }

    const id = lineup_player.steam_id || lineup_player.discord_id;

    // Hasura rejects a null comparison, and a thrown event is never acked, so
    // the plugin would resend it forever.
    if (!id) {
      this.logger.warn(
        `[${this.matchId}] captain event dropped: placeholder ${lineup_player.placeholder_name} has no steam or discord id`,
      );
      return;
    }

    await this.hasura.mutation({
      update_match_lineup_players: {
        __args: {
          where: {
            [lineup_player.steam_id ? "steam_id" : "discord_id"]: {
              _eq: id,
            },
            match_lineup_id: {
              _in: [match.lineup_1_id, match.lineup_2_id],
            },
          },
          _set: {
            captain: this.data.claim,
          },
        },
        affected_rows: true,
      },
    });
  }
}
