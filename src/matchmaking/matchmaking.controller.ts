import { Controller } from "@nestjs/common";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { lobby_players_set_input } from "generated/schema";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { MatchmakingLobbyService } from "./matchmaking-lobby.service";

@Controller("matchmaking")
export class MatchmakingController {
  constructor(
    private readonly matchmakingLobbyService: MatchmakingLobbyService,
  ) {}

  @HasuraEvent()
  public async lobby_players(data: HasuraEventData<lobby_players_set_input>) {
    if (data.new.status === "Invited") {
      return;
    }

    await this.matchmakingLobbyService.removeLobbyFromQueue(
      data.new.lobby_id || data.old.lobby_id,
    );

    await this.matchmakingLobbyService.removeLobbyDetails(
      data.new.lobby_id || data.old.lobby_id,
    );
  }
}
