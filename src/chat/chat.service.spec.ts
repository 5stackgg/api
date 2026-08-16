import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { directRoomId } from "./utilities/directRoomId";

const ME = "76561198000000001";
const FRIEND = "76561198000000002";
const STRANGER = "76561198000000003";

describe("ChatService direct messages", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const redis = {
    hset: jest.fn(),
    hget: jest.fn().mockResolvedValue(null),
    hgetall: jest.fn().mockResolvedValue({}),
    hdel: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    expire: jest.fn(),
    zadd: jest.fn(),
    zrevrange: jest.fn().mockResolvedValue([]),
    publish: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    scard: jest.fn().mockResolvedValue(1),
    sendCommand: jest.fn(),
    eval: jest.fn().mockResolvedValue([1, 1]),
  };

  let service: ChatService;
  let acceptedFriendships: Array<[string, string]>;
  let role: string;
  let queries: Array<{ sql: string; bindings: any[] }>;
  const postgres = {
    query: jest.fn(async (sql: string, bindings: any[]): Promise<any[]> => {
      queries.push({ sql, bindings });
      return [];
    }),
  };

  const client = (steamId: string) =>
    ({
      id: "client-1",
      user: { steam_id: steamId, name: "Someone", role },
      send: jest.fn(),
      on: jest.fn(),
    }) as any;

  const hasuraService = {
    query: jest.fn(async (query: any) => {
      if (query.players_by_pk) {
        return {
          players_by_pk: {
            steam_id: query.players_by_pk.__args.steam_id,
            name: "Someone",
            role,
          },
        };
      }

      if (query.friends) {
        const where = query.friends.__args.where;
        const [first, second] = where._or;
        const pair = [
          first.player_steam_id._eq,
          first.other_player_steam_id._eq,
        ].map(String);

        const matches = acceptedFriendships.some(
          ([a, b]) =>
            (a === pair[0] && b === pair[1]) || (a === pair[1] && b === pair[0]),
        );

        expect(where.status._eq).toBe("Accepted");
        expect(second.player_steam_id._eq).toBe(first.other_player_steam_id._eq);

        return { friends: matches ? [{ status: "Accepted" }] : [] };
      }

      return {};
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    acceptedFriendships = [[ME, FRIEND]];
    role = "user";
    queries = [];
    service = new ChatService(
      logger as any,
      { } as any,
      hasuraService as any,
      postgres as any,
      { getConnection: () => redis } as any,
      { notifyPlayers: jest.fn(), markConversationRead: jest.fn() } as any,
    );
  });

  // Registering a session is the point of no return in joinMatchLobby -- every
  // rejection path returns before it.
  const joined = () => redis.eval.mock.calls.length > 0;

  describe("joining", () => {
    it("lets accepted friends into their conversation", async () => {
      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        directRoomId(ME, FRIEND),
      );

      expect(joined()).toBe(true);
    });

    it("refuses a pair with no accepted friendship", async () => {
      // The room id is just a sorted pair of steam ids, so anyone can compute
      // one for anyone. The friendship is the only real gate.
      acceptedFriendships = [];

      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        directRoomId(ME, STRANGER),
      );

      expect(joined()).toBe(false);
    });

    it("refuses someone who is not a party to the conversation", async () => {
      acceptedFriendships = [[FRIEND, STRANGER]];

      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        directRoomId(FRIEND, STRANGER),
      );

      expect(joined()).toBe(false);
    });

    it("gives an administrator no way in", async () => {
      // Deliberately unlike Draft and Organizer, which do let organizers in --
      // those are group rooms, a DM is a private conversation.
      acceptedFriendships = [];
      role = "administrator";

      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        directRoomId(ME, STRANGER),
      );

      expect(joined()).toBe(false);
    });

    it("refuses a malformed room id", async () => {
      await service.joinMatchLobby(
        client(ME),
        ChatLobbyType.Direct,
        "not-a-room",
      );

      expect(joined()).toBe(false);
    });
  });

  describe("rosters", () => {
    it("resolves both parties of a conversation", async () => {
      expect(
        await service.getLobbyMemberSteamIds(
          ChatLobbyType.Direct,
          directRoomId(ME, FRIEND),
        ),
      ).toEqual([ME, FRIEND]);
    });

    it("has nobody to notify in role-based rooms", async () => {
      expect(
        await service.getLobbyMemberSteamIds(ChatLobbyType.Organizer, "x"),
      ).toEqual([]);
      expect(
        await service.getLobbyMemberSteamIds(ChatLobbyType.Team, "x"),
      ).toEqual([]);
    });
  });

  describe("read state", () => {
    const cursorWrites = () =>
      queries.filter(({ sql }) => sql.includes("chat_read_state"));

    it("ignores a room the caller is not part of", async () => {
      await service.markThreadRead(
        ChatLobbyType.Direct,
        directRoomId(FRIEND, STRANGER),
        { steam_id: ME } as any,
      );

      expect(cursorWrites()).toHaveLength(0);
    });

    it("records a read for a conversation the caller is in", async () => {
      await service.markThreadRead(
        ChatLobbyType.Direct,
        directRoomId(ME, FRIEND),
        { steam_id: ME } as any,
      );

      expect(cursorWrites().at(0)?.bindings).toEqual([
        ME,
        `chat:direct:${directRoomId(ME, FRIEND)}`,
      ]);
    });

    it("records a read for a lobby, not just a conversation", async () => {
      // The cursor is what stops a push firing for a match lobby the recipient
      // is already reading, which was the whole gap.
      await service.markThreadRead(ChatLobbyType.Match, "m-1", {
        steam_id: ME,
      } as any);

      expect(cursorWrites().at(0)?.bindings).toEqual([ME, "chat:match:m-1"]);
    });
  });
});
