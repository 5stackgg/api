import { FriendsService } from "./friends.service";

describe("FriendsService.syncSteamFriends", () => {
  const user = { name: "Me", role: "user", steam_id: "1" } as const;

  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let playerBlocks: { filterUnblocked: jest.Mock };
  let service: FriendsService;
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      json: async () => ({
        friendslist: {
          friends: [{ steamid: "2" }, { steamid: "3" }, { steamid: "4" }],
        },
      }),
    })) as never;

    hasura = {
      query: jest.fn(async () => ({
        players: [{ steam_id: "2" }, { steam_id: "3" }, { steam_id: "4" }],
      })),
      mutation: jest.fn(async () => ({})),
    };
    playerBlocks = { filterUnblocked: jest.fn(async () => ["2", "4"]) };

    service = new FriendsService(
      { get: jest.fn(() => "steam-key") } as never,
      hasura as never,
      playerBlocks as never,
    );
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("never tries to befriend a player on either side of a block", async () => {
    await service.syncSteamFriends(user);

    expect(playerBlocks.filterUnblocked).toHaveBeenCalledWith("1", [
      "2",
      "3",
      "4",
    ]);

    const befriended = hasura.mutation.mock.calls.map(
      ([mutation]) =>
        mutation.insert_friends.__args.objects[0].other_player_steam_id,
    );
    expect(befriended).toEqual(["2", "4"]);
  });
});
