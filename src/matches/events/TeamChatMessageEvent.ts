import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import ChatMessageEvent from "./ChatMessageEvent";

export default class TeamChatMessageEvent extends ChatMessageEvent {
  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  protected async room(): Promise<{ type: ChatLobbyType; id: string } | null> {
    const { lineupId, player } = this.data;

    if (
      typeof lineupId !== "string" ||
      !TeamChatMessageEvent.UUID.test(lineupId)
    ) {
      this.logger.warn(
        `[${this.matchId}] dropping team chat from ${player}: malformed lineup`,
        { lineupId },
      );
      return null;
    }

    const { match_lineups_by_pk } = await this.hasura.query({
      match_lineups_by_pk: {
        __args: {
          id: lineupId,
        },
        id: true,
        match_id: true,
        coach_steam_id: true,
        lineup_players: {
          __args: {
            where: {
              steam_id: {
                _eq: player,
              },
            },
          },
          steam_id: true,
        },
      },
    });

    if (!match_lineups_by_pk || match_lineups_by_pk.match_id !== this.matchId) {
      this.logger.warn(
        `[${this.matchId}] dropping team chat from ${player}: lineup ${lineupId} is not part of this match`,
      );
      return null;
    }

    const isCoach =
      match_lineups_by_pk.coach_steam_id != null &&
      String(match_lineups_by_pk.coach_steam_id) === String(player);

    if (match_lineups_by_pk.lineup_players.length === 0 && !isCoach) {
      this.logger.warn(
        `[${this.matchId}] dropping team chat from ${player}: not on lineup ${lineupId}`,
      );
      return null;
    }

    return {
      type: ChatLobbyType.MatchTeam,
      id: `${match_lineups_by_pk.match_id}:${match_lineups_by_pk.id}`,
    };
  }
}
