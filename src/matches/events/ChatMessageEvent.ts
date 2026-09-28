import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import MatchEventProcessor from "./abstracts/MatchEventProcessor";

export default class ChatMessageEvent extends MatchEventProcessor<{
  player: string;
  message: string;
  teamOnly?: boolean;
  lineupId?: string;
}> {
  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    if (!players_by_pk) {
      this.logger.warn("unable to find player", this.data.player);
      return;
    }

    if (!this.isTeamMessage()) {
      await this.chat.sendMessageToChat(
        ChatLobbyType.Match,
        this.matchId,
        players_by_pk,
        this.data.message,
        true,
        "game",
      );
      return;
    }

    const teamRoomId = await this.teamRoomId();

    if (!teamRoomId) {
      return;
    }

    await this.chat.sendMessageToChat(
      ChatLobbyType.MatchTeam,
      teamRoomId,
      players_by_pk,
      this.data.message,
      true,
      "game",
    );
  }

  // Either field marks a team line, and a team line this cannot place is
  // dropped rather than sent to the match room, which holds the other team too.
  private isTeamMessage(): boolean {
    return Boolean(this.data.teamOnly) || this.data.lineupId != null;
  }

  private async teamRoomId(): Promise<string | null> {
    const { teamOnly, lineupId, player } = this.data;

    if (
      teamOnly !== true ||
      typeof lineupId !== "string" ||
      !ChatMessageEvent.UUID.test(lineupId)
    ) {
      this.logger.warn(
        `[${this.matchId}] dropping team chat from ${player}: malformed lineup`,
        { teamOnly, lineupId },
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

    return `${match_lineups_by_pk.match_id}:${match_lineups_by_pk.id}`;
  }
}
