import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class ChatMessageEvent extends MatchEventProcessor<{
  player: string;
  message: string;
}> {
  public async process() {
    const { players_by_pk } = await this.hasura.query({
      players_by_pk: {
        __args: {
          steam_id: this.data.player,
        },
        name: true,
        role: true,
        steam_id: true,
        profile_url: true,
        avatar_url: true,
        discord_id: true,
      },
    });

    await this.matchSockets.sendMessageToChat(
      players_by_pk,
      this.matchId,
      this.data.message,
      true,
    );
  }
}
