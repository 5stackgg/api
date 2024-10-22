import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class PlayerDisconnected extends MatchEventProcessor<{
  steam_id: string;
}> {
  public async process() {
    await this.matchLobby.leaveLobbyViaGame(this.matchId, this.data.steam_id);
  }
}
