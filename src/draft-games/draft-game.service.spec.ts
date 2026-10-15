import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { DraftGameService } from "./draft-game.service";
import { DraftGame } from "./types/DraftGame";

describe("DraftGameService player blocks", () => {
  const host: User = { name: "Host", role: "user", steam_id: "100" };
  const organizer: User = {
    name: "Organizer",
    role: "match_organizer",
    steam_id: "200",
  };
  const target = "300";

  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let playerBlocks: {
    isBlockedEitherWay: jest.Mock;
    filterUnblocked: jest.Mock;
  };
  let service: DraftGameService;

  const draftGame = (): DraftGame =>
    ({
      id: "draft-1",
      host_steam_id: host.steam_id,
      status: "Open",
      type: "Competitive",
      capacity: 10,
      players: [
        {
          steam_id: host.steam_id,
          name: "Host",
          is_captain: false,
          status: "Accepted",
        },
      ],
    }) as DraftGame;

  beforeEach(() => {
    hasura = {
      query: jest.fn(async () => ({
        settings_by_pk: null as { value: string } | null,
      })),
      mutation: jest.fn(async () => ({})),
    };
    playerBlocks = {
      isBlockedEitherWay: jest.fn(async () => true),
      filterUnblocked: jest.fn(async () => [host.steam_id, "400"]),
    };

    service = new DraftGameService(
      new Logger("DraftGameServiceTest"),
      hasura as never,
      {
        lock: jest.fn(async (_key: string, callback: () => unknown) =>
          callback(),
        ),
      } as never,
      {} as never,
      {} as never,
      { notifyPlayers: jest.fn() } as never,
      playerBlocks as never,
    );

    jest.spyOn(service, "getDraftGame").mockResolvedValue(draftGame());
    jest.spyOn(service, "getPlayerElo").mockResolvedValue(5000);
    jest
      .spyOn(service as never, "verifyPlayerEligible")
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, "getPlayerActiveDraftGame")
      .mockResolvedValue(null as never);
    jest
      .spyOn(service as never, "clearOtherRequests")
      .mockResolvedValue(undefined as never);
  });

  it("refuses a host adding a player either of them has blocked", async () => {
    await expect(
      service.addDraftPlayer(host, "draft-1", target),
    ).rejects.toThrow("player_blocked");

    expect(playerBlocks.isBlockedEitherWay).toHaveBeenCalledWith(
      host.steam_id,
      target,
    );
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("lets a host add a player when there is no block", async () => {
    playerBlocks.isBlockedEitherWay.mockResolvedValue(false);

    await service.addDraftPlayer(host, "draft-1", target);

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        insert_draft_game_players_one: expect.anything(),
      }),
    );
  });

  it("keeps re-adding somebody already in the draft a no-op", async () => {
    await service.addDraftPlayer(host, "draft-1", host.steam_id);

    expect(playerBlocks.isBlockedEitherWay).not.toHaveBeenCalled();
    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("does not hold a match organizer's roster edit to the block", async () => {
    await service.addDraftPlayer(organizer, "draft-1", target);

    expect(playerBlocks.isBlockedEitherWay).not.toHaveBeenCalled();
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        insert_draft_game_players_one: expect.anything(),
      }),
    );
  });

  describe("Teams-mode roster seeding", () => {
    const roster = [
      { steam_id: host.steam_id, lineup: 1 },
      { steam_id: target, lineup: 1 },
      { steam_id: "400", lineup: 2 },
    ];

    it("drops the players on either side of a block with the host", async () => {
      await expect(
        service["withoutBlockedPlayers"](host, roster),
      ).resolves.toEqual([roster[0], roster[2]]);
      expect(playerBlocks.filterUnblocked).toHaveBeenCalledWith(host.steam_id, [
        host.steam_id,
        target,
        "400",
      ]);
    });

    it("leaves a match organizer's roster as sent", async () => {
      await expect(
        service["withoutBlockedPlayers"](organizer, roster),
      ).resolves.toEqual(roster);
      expect(playerBlocks.filterUnblocked).not.toHaveBeenCalled();
    });
  });

  describe("editing settings", () => {
    const settings = {
      type: "Duel",
      mode: "Pug",
      map_pool_id: "pool-1",
      options: { mr: "8", map_pool_id: "pool-1", game_mode_id: "mode-1" },
    } as never;

    it("keeps the game mode a quick-hosted room is saved with, on an options row linked to the room", async () => {
      jest.spyOn(service, "getDraftGame").mockResolvedValue({
        ...draftGame(),
        type: "Duel",
        capacity: 2,
      });
      hasura.mutation.mockResolvedValue({
        insert_match_options_one: { id: "options-1" },
      });

      await service.updateDraftSettings(organizer, "draft-1", settings);

      expect(hasura.mutation).toHaveBeenCalledWith({
        insert_match_options_one: {
          __args: {
            object: expect.objectContaining({
              type: "Duel",
              game_mode_id: "mode-1",
              map_pool_id: "pool-1",
            }),
          },
          id: true,
        },
      });
      expect(hasura.mutation).toHaveBeenCalledWith({
        update_draft_games_by_pk: {
          __args: {
            pk_columns: { id: "draft-1" },
            _set: { match_options_id: "options-1" },
          },
          __typename: true,
        },
      });
    });

    it("updates an existing options row in place", async () => {
      jest.spyOn(service, "getDraftGame").mockResolvedValue({
        ...draftGame(),
        type: "Duel",
        capacity: 2,
        match_options_id: "options-1",
      });

      await service.updateDraftSettings(organizer, "draft-1", settings);

      expect(hasura.mutation).toHaveBeenCalledWith({
        update_match_options_by_pk: {
          __args: {
            pk_columns: { id: "options-1" },
            _set: expect.objectContaining({
              type: "Duel",
              game_mode_id: "mode-1",
            }),
          },
          __typename: true,
        },
      });
      expect(hasura.mutation).not.toHaveBeenCalledWith(
        expect.objectContaining({
          insert_match_options_one: expect.anything(),
        }),
      );
    });
  });
});
