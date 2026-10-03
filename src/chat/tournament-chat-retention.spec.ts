import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { SystemSettingName } from "../system/enums/SystemSettingName";

const SEVEN_DAYS = 60 * 60 * 24 * 7;

describe("tournament chat retention", () => {
  const fallback = (setting: SystemSettingName) =>
    ChatService.TTL_SETTINGS.find((entry) => entry.setting === setting)
      ?.fallback;

  it("keeps tournament chat seven days unless an operator says otherwise", () => {
    expect(fallback(SystemSettingName.ChatTtlTournament)).toBe(SEVEN_DAYS);
  });

  it("leaves the organizers' room default alone", () => {
    expect(fallback(SystemSettingName.ChatTtlOrganizers)).toBe(60 * 60 * 24);
  });

  it("stores a tournament line for seven days before any setting has loaded", async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      hset: jest.fn(),
      sendCommand: jest.fn(),
      smembers: jest.fn().mockResolvedValue([]),
      publish: jest.fn(),
    };

    const service = new ChatService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {} as any,
      { query: jest.fn().mockResolvedValue({}) } as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      { getConnection: () => redis } as any,
      { sendChatMessage: jest.fn() } as any,
      { blockedAmong: jest.fn(async () => new Map()) } as any,
      {
        claim: jest.fn(),
        expireMessage: jest.fn(async () => {}),
        markDeleted: jest.fn(async () => {}),
        moveRoom: jest.fn(async () => {}),
      } as any,
      { enabled: jest.fn(async () => false) } as any,
    );

    await service.sendMessageToChat(
      ChatLobbyType.Tournament,
      "11111111-1111-4111-8111-111111111111",
      { steam_id: "76561198000000001", name: "p", role: "user" } as any,
      "gg",
      true,
      "game",
    );

    const hexpire = redis.sendCommand.mock.calls
      .map(([command]) => command)
      .find((command: any) => command.name === "HEXPIRE");

    expect(Number(hexpire.args[1])).toBe(SEVEN_DAYS);
  });
});
