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

  // Which matches this player belongs to, by id.
  let myMatches: string[];
  // The one tournament the fake knows about, and who is attached to it.
  let tournament: {
    organizers: string[];
    teamOwners: string[];
    roster: string[];
    freeAgents: Array<{ steam_id: string; status: string }>;
  };
  // Who the organizers' role gate admits.
  let staff: string[];

  // Answers the access query the way the database would, so the assertions are
  // about who gets in rather than about the shape of the query.
  const tournamentAdmits = (where: any) =>
    (where._or ?? []).some((branch: any) => {
      if (branch.is_organizer) {
        return tournament.organizers.includes(String(steamIdIn(branch)));
      }

      if (branch.teams) {
        return branch.teams._or.some((teamBranch: any) => {
          const steamId = String(steamIdIn(teamBranch));
          return teamBranch.owner_steam_id
            ? tournament.teamOwners.includes(steamId)
            : tournament.roster.includes(steamId);
        });
      }

      if (branch.free_agents) {
        const steamId = String(branch.free_agents.player_steam_id._eq);
        const statuses = branch.free_agents.status?._in ?? [];

        return tournament.freeAgents.some(
          (freeAgent) =>
            freeAgent.steam_id === steamId &&
            statuses.includes(freeAgent.status),
        );
      }

      return false;
    });

  // the steam id buried anywhere in one branch of the _or
  const steamIdIn = (branch: any): string | undefined => {
    if (typeof branch !== "object" || branch === null) {
      return undefined;
    }

    for (const [key, value] of Object.entries<any>(branch)) {
      if (key.endsWith("steam_id") && value?._eq !== undefined) {
        return String(value._eq);
      }

      const nested = Array.isArray(value)
        ? value.map(steamIdIn).find(Boolean)
        : steamIdIn(value);

      if (nested) {
        return nested;
      }
    }

    return undefined;
  };

  const hasuraService = {
    query: jest.fn(async (query: any) => {
      if (query.tournaments) {
        return {
          tournaments: tournamentAdmits(query.tournaments.__args.where)
            ? [{ id: "t-1" }]
            : [],
        };
      }

      if (query.tournaments_by_pk) {
        return {
          tournaments_by_pk: {
            organizer_steam_id: tournament.organizers[0],
            organizers: tournament.organizers
              .slice(1)
              .map((steam_id) => ({ steam_id })),
            teams: [
              {
                owner_steam_id: tournament.teamOwners[0],
                roster: tournament.roster.map((player_steam_id) => ({
                  player_steam_id,
                })),
              },
            ],
            free_agents: tournament.freeAgents
              .filter((freeAgent) =>
                (
                  query.tournaments_by_pk.free_agents?.__args?.where?.status
                    ?._in ?? []
                ).includes(freeAgent.status),
              )
              .map((freeAgent) => ({
                player_steam_id: freeAgent.steam_id,
                status: freeAgent.status,
              })),
          },
        };
      }

      if (query.matches_by_pk) {
        return myMatches.includes(query.matches_by_pk.__args.id)
          ? {
              matches_by_pk: {
                is_coach: false,
                is_organizer: false,
                is_in_lineup: true,
              },
            }
          : {};
      }

      if (query.players) {
        return { players: staff.map((steam_id) => ({ steam_id })) };
      }

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
    myMatches = ["m-1"];
    tournament = {
      organizers: [STRANGER],
      teamOwners: [],
      roster: [],
      freeAgents: [],
    };
    staff = [];
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

  describe("tournament chat", () => {
    const join = async (steamId: string) => {
      await service.joinMatchLobby(
        client(steamId),
        ChatLobbyType.Tournament,
        "t-1",
      );
      return joined();
    };

    it("lets a player on a tournament team roster in", async () => {
      tournament.roster = [ME];

      expect(await join(ME)).toBe(true);
    });

    it("lets a registered free agent in", async () => {
      // in a free-agent tournament nobody is on a roster until the draft, so
      // this is everyone who signed up
      tournament.freeAgents = [{ steam_id: ME, status: "registered" }];

      expect(await join(ME)).toBe(true);
    });

    it("lets a waitlisted free agent in", async () => {
      tournament.freeAgents = [{ steam_id: ME, status: "waitlisted" }];

      expect(await join(ME)).toBe(true);
    });

    it("keeps a withdrawn free agent out", async () => {
      tournament.freeAgents = [{ steam_id: ME, status: "withdrawn" }];

      expect(await join(ME)).toBe(false);
    });

    it("keeps an unrelated player out", async () => {
      expect(await join(ME)).toBe(false);
    });

    // the message write is the awaited step; the broadcast after it is
    // deliberately fire-and-forget
    const posted = () =>
      redis.hset.mock.calls.some(([key]) => key === "chat_tournament_t-1");

    it("stops a free agent who withdrew from posting", async () => {
      // the room's membership lives in redis for 24h, so leaving the pool has
      // to be re-checked when the message is sent, not only when joining
      redis.hget.mockResolvedValue(JSON.stringify({ steam_id: ME }));
      tournament.freeAgents = [{ steam_id: ME, status: "withdrawn" }];

      await service.sendMessageToChat(
        ChatLobbyType.Tournament,
        "t-1",
        { steam_id: ME, name: "Someone", role } as any,
        "still here",
      );

      expect(posted()).toBe(false);
    });

    it("lets a registered free agent post", async () => {
      redis.hget.mockResolvedValue(JSON.stringify({ steam_id: ME }));
      tournament.freeAgents = [{ steam_id: ME, status: "registered" }];

      await service.sendMessageToChat(
        ChatLobbyType.Tournament,
        "t-1",
        { steam_id: ME, name: "Someone", role } as any,
        "hello",
      );

      expect(posted()).toBe(true);
    });

    it("notifies free agents as well as rostered players", async () => {
      tournament.organizers = [STRANGER];
      tournament.teamOwners = [FRIEND];
      tournament.roster = [FRIEND];
      tournament.freeAgents = [
        { steam_id: ME, status: "registered" },
        { steam_id: "76561198000000004", status: "withdrawn" },
      ];

      const recipients = await service.getLobbyMemberSteamIds(
        ChatLobbyType.Tournament,
        "t-1",
      );

      expect(recipients).toContain(ME);
      expect(recipients).toContain(FRIEND);
      expect(recipients).toContain(STRANGER);
      expect(recipients).not.toContain("76561198000000004");
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

    // The organizers' room has no roster of its own, so an empty list here is
    // indistinguishable from a room nobody can be notified about -- which is
    // what it silently was.
    it("resolves the organizers' room through its role gate", async () => {
      staff = [ME, FRIEND];

      expect(
        await service.getLobbyMemberSteamIds(ChatLobbyType.Organizer, "x"),
      ).toEqual([ME, FRIEND]);

      const [{ players }] = hasuraService.query.mock.calls.at(-1);

      expect(players.__args.where.role._in).toEqual([
        "match_organizer",
        "tournament_organizer",
        "administrator",
      ]);
    });

    it("has nobody to notify in a team room", async () => {
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

    it("refuses a lobby the caller has no business in", async () => {
      // `type` and `id` are unvalidated socket input, so without the same gate
      // joining uses, a client can write a row per call for any id it invents.
      await service.markThreadRead(ChatLobbyType.Match, "m-2", {
        steam_id: ME,
      } as any);

      expect(cursorWrites()).toHaveLength(0);
    });
  });
});
