import { PlayerReindexService } from "./player-reindex.service";

describe("PlayerReindexService indexed-schema marker", () => {
  let cache: Record<string, jest.Mock>;
  let typeSense: { updatePlayer: jest.Mock; markPlayersIndexed: jest.Mock };
  let service: PlayerReindexService;

  beforeEach(() => {
    cache = {
      acquireLock: jest.fn().mockResolvedValue(true),
      refreshLock: jest.fn().mockResolvedValue(undefined),
      forget: jest.fn().mockResolvedValue(undefined),
      put: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(undefined),
    };
    typeSense = {
      updatePlayer: jest.fn().mockResolvedValue({}),
      markPlayersIndexed: jest.fn().mockResolvedValue(undefined),
    };

    service = new PlayerReindexService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {
        query: jest
          .fn()
          .mockResolvedValue([{ steam_id: 1n }, { steam_id: 2n }]),
      } as any,
      cache as any,
      { send: jest.fn().mockResolvedValue(undefined) } as any,
      typeSense as any,
    );
  });

  it("records the schema after every player was reindexed", async () => {
    await service.runReindexAll();

    expect(typeSense.updatePlayer).toHaveBeenCalledTimes(2);
    expect(typeSense.markPlayersIndexed).toHaveBeenCalledTimes(1);
  });

  it("does not record the schema when a player failed", async () => {
    typeSense.updatePlayer.mockRejectedValueOnce(new Error("typesense down"));

    await service.runReindexAll();

    expect(typeSense.markPlayersIndexed).not.toHaveBeenCalled();
  });

  it("does not record the schema when the run was canceled", async () => {
    cache.get.mockImplementation(async (key: string) => {
      return key === "player-reindex:cancel" ? true : undefined;
    });

    await service.runReindexAll();

    expect(typeSense.updatePlayer).not.toHaveBeenCalled();
    expect(typeSense.markPlayersIndexed).not.toHaveBeenCalled();
  });
});
