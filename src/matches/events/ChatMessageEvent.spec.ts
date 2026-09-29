import { Logger } from "@nestjs/common";
import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import ChatMessageEvent from "./ChatMessageEvent";

const MATCH_ID = "11111111-1111-1111-1111-111111111111";
const LINEUP_ID = "22222222-2222-2222-2222-222222222222";
const SPEAKER = "76561198000000001";

describe("ChatMessageEvent", () => {
  let processor: ChatMessageEvent;
  let hasura: { query: jest.Mock };
  let chat: { sendMessageToChat: jest.Mock };
  let logger: Logger;
  let speaker: Record<string, unknown> | null;

  beforeEach(() => {
    speaker = {
      name: "keith",
      role: "user",
      steam_id: SPEAKER,
      profile_url: null,
      avatar_url: null,
      discord_id: null,
    };

    hasura = {
      query: jest.fn(async (query: Record<string, any>) => {
        if (query.players_by_pk) {
          return { players_by_pk: speaker };
        }

        throw new Error("unexpected query");
      }),
    };
    chat = { sendMessageToChat: jest.fn(async () => ({ accepted: true })) };
    logger = new Logger("ChatMessageEventTest");
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);

    processor = new ChatMessageEvent(
      logger,
      hasura as any,
      {} as any,
      chat as any,
      {} as any,
    );
  });

  const send = async (data: Record<string, unknown>) => {
    processor.setData(MATCH_ID, {
      player: SPEAKER,
      message: "gl hf",
      ...data,
    } as any);

    await processor.process();
  };

  it("relays all chat into the match room", async () => {
    await send({});

    expect(chat.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(chat.sendMessageToChat).toHaveBeenCalledWith(
      ChatLobbyType.Match,
      MATCH_ID,
      expect.objectContaining({ steam_id: SPEAKER }),
      "gl hf",
      true,
      "game",
    );
  });

  it("drops a line from a player it does not know", async () => {
    speaker = null;

    await send({});

    expect(chat.sendMessageToChat).not.toHaveBeenCalled();
  });

  // team lines have their own event; one on this event is from a plugin on
  // the contract that sent them as chat, and must not reach the other team
  describe("drops team fields instead of posting them to the match room", () => {
    it.each([
      ["a team line", { teamOnly: true, lineupId: LINEUP_ID }],
      ["a lone team flag", { teamOnly: true }],
      ["a lone lineup", { lineupId: LINEUP_ID }],
      ["a false team flag", { teamOnly: false }],
      ["a null lineup", { lineupId: null }],
    ])("%s", async (_, data) => {
      await send(data);

      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
      expect(hasura.query).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("dropping chat"),
        expect.anything(),
      );
    });
  });
});
