import { ForbiddenException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ChatController } from "./chat.controller";
import { SteamGuard } from "../auth/strategies/SteamGuard";

const MATCH = "11111111-1111-4111-8111-111111111111";

describe("match chat log endpoint", () => {
  const user = { steam_id: "76561198000000001", role: "administrator" };

  it("needs a signed-in player", () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        ChatController.prototype.matchChatLog,
      ),
    ).toContain(SteamGuard);
  });

  it("answers a refusal with a 403", async () => {
    const chatService = { matchChatLog: jest.fn().mockResolvedValue(null) };
    const controller = new ChatController(chatService as any);

    await expect(
      controller.matchChatLog({ user } as any, MATCH),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(chatService.matchChatLog).toHaveBeenCalledWith(MATCH, user);
  });

  it("hands back the log", async () => {
    const read = {
      match: [],
      teams: [],
      team_chat_withheld: true,
      expires_at: null,
    };
    const controller = new ChatController({
      matchChatLog: jest.fn().mockResolvedValue(read),
    } as any);

    await expect(controller.matchChatLog({ user } as any, MATCH)).resolves.toBe(
      read,
    );
  });
});
