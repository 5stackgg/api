import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ChatController } from "./chat.controller";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

const MATCH = "6f1c1c1e-5b1a-4c55-9a51-111111111111";
const LINEUP = "6f1c1c1e-5b1a-4c55-9a51-222222222222";

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
      controller.roomMembers(
        request,
        ChatLobbyType.MatchTeam,
        `${MATCH}:${LINEUP}`,
      ),
    ).resolves.toEqual({ members });

    expect(chat.mentionCandidates).toHaveBeenCalledWith(
      ChatLobbyType.MatchTeam,
      `${MATCH}:${LINEUP}`,
      request.user,
    );
  });

  it("refuses a room the player cannot read", async () => {
    chat.mentionCandidates.mockResolvedValue(null);

    await expect(
      controller.roomMembers(request, ChatLobbyType.Tournament, MATCH),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    [ChatLobbyType.Tournament, "t-1"],
    [ChatLobbyType.Match, "not-a-uuid"],
    [ChatLobbyType.MatchTeam, MATCH],
  ])("answers a malformed %s room id with a 400", async (type, id) => {
    await expect(
      controller.roomMembers(request, type, id),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(chat.mentionCandidates).not.toHaveBeenCalled();
  });

  it("refuses a lobby type it does not know", async () => {
    await expect(
      controller.roomMembers(request, "global" as ChatLobbyType, "x"),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(chat.mentionCandidates).not.toHaveBeenCalled();
  });
});
