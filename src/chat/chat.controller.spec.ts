import { ForbiddenException } from "@nestjs/common";
import { ChatController } from "./chat.controller";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

describe("ChatController room members", () => {
  const request = { user: { steam_id: "76561198000000001" } } as any;
  let chat: { mentionCandidates: jest.Mock };
  let controller: ChatController;

  beforeEach(() => {
    chat = { mentionCandidates: jest.fn() };
    controller = new ChatController(chat as any);
  });

  it("answers with who can be tagged in the room", async () => {
    const members = [
      {
        steam_id: "76561198000000002",
        name: "kairo",
        avatar_url: null as string | null,
        team: "Northwind",
        organizer: false,
      },
    ];
    chat.mentionCandidates.mockResolvedValue(members);

    await expect(
      controller.roomMembers(request, ChatLobbyType.MatchTeam, "m-1:l-1"),
    ).resolves.toEqual({ members });

    expect(chat.mentionCandidates).toHaveBeenCalledWith(
      ChatLobbyType.MatchTeam,
      "m-1:l-1",
      request.user,
    );
  });

  it("refuses a room the player cannot read", async () => {
    chat.mentionCandidates.mockResolvedValue(null);

    await expect(
      controller.roomMembers(request, ChatLobbyType.Tournament, "t-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a lobby type it does not know", async () => {
    await expect(
      controller.roomMembers(request, "global" as ChatLobbyType, "x"),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(chat.mentionCandidates).not.toHaveBeenCalled();
  });
});
