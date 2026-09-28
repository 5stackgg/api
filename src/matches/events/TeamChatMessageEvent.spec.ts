import { Logger } from "@nestjs/common";
import { ChatLobbyType } from "src/chat/enums/ChatLobbyTypes";
import TeamChatMessageEvent from "./TeamChatMessageEvent";

const MATCH_ID = "11111111-1111-1111-1111-111111111111";
const LINEUP_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_MATCH_ID = "33333333-3333-3333-3333-333333333333";
const SPEAKER = "76561198000000001";
const COACH = "76561198000000002";
const TEAMMATE = "76561198000000003";

describe("TeamChatMessageEvent", () => {
  let processor: TeamChatMessageEvent;
  let hasura: { query: jest.Mock };
  let chat: { sendMessageToChat: jest.Mock };
  let known: boolean;
  let lineup: {
    id: string;
    match_id: string;
    coach_steam_id: string | null;
    lineup_players: Array<{ steam_id: string }>;
  } | null;

  beforeEach(() => {
    known = true;
    lineup = {
      id: LINEUP_ID,
      match_id: MATCH_ID,
      coach_steam_id: COACH,
      lineup_players: [{ steam_id: SPEAKER }, { steam_id: TEAMMATE }],
    };

    hasura = {
      query: jest.fn(async (query: Record<string, any>) => {
        if (query.players_by_pk) {
          return {
            players_by_pk: known
              ? {
                  name: "keith",
                  role: "user",
                  steam_id: query.players_by_pk.__args.steam_id,
                  profile_url: null as string | null,
                  avatar_url: null as string | null,
                  discord_id: null as string | null,
                }
              : null,
          };
        }

        if (query.match_lineups_by_pk) {
          const speakerId =
            query.match_lineups_by_pk.lineup_players.__args.where.steam_id._eq;

          return {
            match_lineups_by_pk: lineup && {
              ...lineup,
              lineup_players: lineup.lineup_players.filter(
                ({ steam_id }) => steam_id === speakerId,
              ),
            },
          };
        }

        throw new Error("unexpected query");
      }),
    };
    chat = { sendMessageToChat: jest.fn(async () => ({ accepted: true })) };

    const logger = new Logger("TeamChatMessageEventTest");
    jest.spyOn(logger, "warn").mockImplementation(() => undefined);

    processor = new TeamChatMessageEvent(
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
      message: "rotate b",
      ...data,
    } as any);

    await processor.process();
  };

  const lineupQuery = () =>
    hasura.query.mock.calls
      .map(([query]) => query.match_lineups_by_pk)
      .find(Boolean);

  it("relays team chat into the speaker's team room", async () => {
    await send({ lineupId: LINEUP_ID });

    expect(chat.sendMessageToChat).toHaveBeenCalledTimes(1);
    expect(chat.sendMessageToChat).toHaveBeenCalledWith(
      ChatLobbyType.MatchTeam,
      `${MATCH_ID}:${LINEUP_ID}`,
      expect.objectContaining({ steam_id: SPEAKER }),
      "rotate b",
      true,
      "game",
    );
  });

  it("checks the speaker against the lineup the plugin named", async () => {
    await send({ lineupId: LINEUP_ID });

    expect(lineupQuery().__args).toEqual({ id: LINEUP_ID });
    expect(lineupQuery().lineup_players.__args).toEqual({
      where: { steam_id: { _eq: SPEAKER } },
    });
  });

  it("lets the lineup's coach speak in its team room", async () => {
    await send({ player: COACH, message: "timeout", lineupId: LINEUP_ID });

    expect(chat.sendMessageToChat).toHaveBeenCalledWith(
      ChatLobbyType.MatchTeam,
      `${MATCH_ID}:${LINEUP_ID}`,
      expect.objectContaining({ steam_id: COACH }),
      "timeout",
      true,
      "game",
    );
  });

  it("keys the room on the lineup as stored, whatever case the plugin sent", async () => {
    await send({ lineupId: LINEUP_ID.toUpperCase() });

    expect(chat.sendMessageToChat.mock.calls[0][1]).toBe(
      `${MATCH_ID}:${LINEUP_ID}`,
    );
  });

  describe("never falls back to the match room", () => {
    const expectDropped = () => {
      expect(chat.sendMessageToChat).not.toHaveBeenCalled();
    };

    it("drops team chat without a lineup", async () => {
      await send({});

      expectDropped();
      expect(hasura.query).not.toHaveBeenCalled();
    });

    it("drops a lineup id that is not a uuid", async () => {
      await send({ lineupId: "lineup-1" });

      expectDropped();
      expect(hasura.query).not.toHaveBeenCalled();
    });

    it("drops a lineup id that is not a string", async () => {
      await send({ lineupId: 42 });

      expectDropped();
      expect(hasura.query).not.toHaveBeenCalled();
    });

    it("drops a lineup that does not exist", async () => {
      lineup = null;

      await send({ lineupId: LINEUP_ID });

      expectDropped();
    });

    it("drops a lineup from another match", async () => {
      lineup!.match_id = OTHER_MATCH_ID;

      await send({ lineupId: LINEUP_ID });

      expectDropped();
    });

    it("drops a speaker who is not on the lineup", async () => {
      lineup!.lineup_players = [{ steam_id: TEAMMATE }];

      await send({ lineupId: LINEUP_ID });

      expectDropped();
    });

    it("drops a speaker when the lineup has no coach", async () => {
      lineup!.lineup_players = [{ steam_id: TEAMMATE }];
      lineup!.coach_steam_id = null;

      await send({ lineupId: LINEUP_ID });

      expectDropped();
    });

    it("drops a line from a player it does not know", async () => {
      known = false;

      await send({ lineupId: LINEUP_ID });

      expectDropped();
    });
  });
});
