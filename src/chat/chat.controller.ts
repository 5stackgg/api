import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { HasuraEvent } from "src/hasura/hasura.controller";
import { SteamGuard } from "src/auth/strategies/SteamGuard";
import { ChatService } from "./chat.service";
import { lobbies_set_input } from "generated/schema";
import { HasuraEventData } from "src/hasura/types/HasuraEventData";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

@Controller("chat")
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // Hydrates the DM tab bar on login. This is also where DM tabs persist:
  // the client keeps no storage of its own, and the server already knows every
  // conversation and its unread count.
  @Get("direct/conversations")
  @UseGuards(SteamGuard)
  public async directConversations(@Req() request: Request) {
    return {
      conversations: await this.chatService.getDirectConversations(
        request.user,
      ),
    };
  }

  @HasuraEvent()
  public async chat_lobbies_removed(data: HasuraEventData<lobbies_set_input>) {
    await this.chatService.removeLobby(ChatLobbyType.MatchMaking, data.old.id);
  }
}
