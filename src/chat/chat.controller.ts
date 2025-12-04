import { Controller } from "@nestjs/common";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { ChatService } from "./chat.service";
import { lobbies_set_input } from "generated/schema";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

@Controller("chat")
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @HasuraEvent()
  public async chat_lobbies_removed(data: HasuraEventData<lobbies_set_input>) {
    await this.chatService.removeLobby(ChatLobbyType.MatchMaking, data.old.id);
  }
}
