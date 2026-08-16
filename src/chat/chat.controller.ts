import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
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

  // Add or remove a conversation from the player's rail. Per-participant, so
  // the other party is never told anything by it.
  @Put("direct/conversations/:roomId/open")
  @UseGuards(SteamGuard)
  public async setConversationOpen(
    @Req() request: Request,
    @Param("roomId") roomId: string,
    @Body() body: { open?: boolean },
  ) {
    await this.chatService.setConversationOpen(
      roomId,
      request.user,
      body?.open !== false,
    );

    return { success: true };
  }

  // The rail's order, written whole rather than as a move, so a drag lands as
  // one request and cannot half-apply.
  @Put("direct/conversations/order")
  @UseGuards(SteamGuard)
  public async reorderConversations(
    @Req() request: Request,
    @Body() body: { roomIds?: string[] },
  ) {
    await this.chatService.reorderConversations(
      Array.isArray(body?.roomIds) ? body.roomIds : [],
      request.user,
    );

    return { success: true };
  }

  // Where the player has read up to in each thread. The client already holds
  // each room's messages, so a cursor is all it needs to size its own badges --
  // and unlike the in-memory counts it had before, this survives a reload and
  // agrees across devices.
  @Get("threads")
  @UseGuards(SteamGuard)
  public async threads(@Req() request: Request) {
    return {
      threads: await this.chatService.getReadState(request.user),
    };
  }

  @HasuraEvent()
  public async chat_lobbies_removed(data: HasuraEventData<lobbies_set_input>) {
    await this.chatService.removeLobby(ChatLobbyType.MatchMaking, data.old.id);
  }
}
