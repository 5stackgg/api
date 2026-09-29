import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class ChatMessageEvent extends MatchEventProcessor<{
  player: string;
  message: string;
  teamOnly?: unknown;
  lineupId?: unknown;
}> {
  public async process() {
    const room = await this.room();

    if (!room) {
      return;
    }

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

    if (!players_by_pk) {
      this.logger.warn("unable to find player", this.data.player);
      return;
    }

    await this.chat.sendMessageToChat(
      room.type,
      room.id,
      players_by_pk,
      this.data.message,
      true,
      "game",
    );
  }

  // Team lines travel as teamChat so an api that predates them drops them as
  // an unknown event. One that still carries team fields here comes from a
  // plugin on the old contract, and the match room holds the other team too.
  protected async room(): Promise<{ type: ChatLobbyType; id: string } | null> {
    const { teamOnly, lineupId, player } = this.data;

    if (teamOnly !== undefined || lineupId !== undefined) {
      this.logger.warn(
        `[${this.matchId}] dropping chat from ${player}: team fields on the all chat event`,
        { teamOnly, lineupId },
      );
      return null;
    }

    return { type: ChatLobbyType.Match, id: this.matchId };
  }
}
