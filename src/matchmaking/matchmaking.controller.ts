import { Controller, Logger } from "@nestjs/common";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { lobby_players_set_input } from "generated/schema";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";

@Controller("matchmaking")
export class MatchmakingController {
  constructor(
    private readonly logger: Logger,
    private readonly matchmakingLobbyService: MatchmakingLobbyService,
  ) {}

  @HasuraEvent()
  public async lobby_players(data: HasuraEventData<lobby_players_set_input>) {
    if (data.new.status === "Invited") {
      return;
    }

    if (data.old.lobby_id) {
      void this.removeLobbyFromQueue(data.old.lobby_id);
    }
    if (data.new.lobby_id) {
      void this.removeLobbyFromQueue(data.new.lobby_id);
    }

    if (data.old.steam_id) {
      void this.removeLobbyFromQueue(data.old.steam_id);
    }

    if (data.new.steam_id) {
      void this.removeLobbyFromQueue(data.new.steam_id);
    }
  }

  private async removeLobbyFromQueue(lobbyId: string) {
    try {
      const removed =
        await this.matchmakingLobbyService.removeLobbyFromQueue(lobbyId);

      if (!removed) {
        return;
      }

      await this.matchmakingLobbyService.removeLobbyDetails(lobbyId);
    } catch (error) {
      this.logger.error(`error removing lobby from queue`, error);
    }
  }
}
