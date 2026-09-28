import { Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import { DraftGameService } from "./draft-game.service";
import { DraftGame } from "./types/DraftGame";

describe("DraftGameService.addDraftPlayer", () => {
  const host: User = { name: "Host", role: "user", steam_id: "100" };
  const organizer: User = {
    name: "Organizer",
    role: "match_organizer",
    steam_id: "200",
  };
  const target = "300";

  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let playerBlocks: { isBlockedEitherWay: jest.Mock };
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
      query: jest.fn(async () => ({ settings_by_pk: null })),
      mutation: jest.fn(async () => ({})),
    };
    playerBlocks = { isBlockedEitherWay: jest.fn(async () => true) };

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

  it("does not hold a match organizer's roster edit to the block", async () => {
    await service.addDraftPlayer(organizer, "draft-1", target);

    expect(playerBlocks.isBlockedEitherWay).not.toHaveBeenCalled();
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        insert_draft_game_players_one: expect.anything(),
      }),
    );
  });
});
