import { PlayerReindexService } from "./player-reindex.service";
import { RefreshAllPlayersJob } from "./jobs/RefreshAllPlayers";

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
      getRaw: jest.fn().mockResolvedValue(null),
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

  it("takes over the lock a stalled run of the same job left behind", async () => {
    cache.acquireLock.mockResolvedValue(false);
    cache.getRaw.mockResolvedValue("RefreshAllPlayersJob:1700000000000");

    await service.runReindexAll("RefreshAllPlayersJob:1700000000000");

    expect(typeSense.updatePlayer).toHaveBeenCalledTimes(2);
    expect(typeSense.markPlayersIndexed).toHaveBeenCalledTimes(1);
  });

  it("skips while a different run holds the lock", async () => {
    cache.acquireLock.mockResolvedValue(false);
    cache.getRaw.mockResolvedValue("RefreshAllPlayersJob:1600000000000");

    await service.runReindexAll("RefreshAllPlayersJob:1700000000000");

    expect(typeSense.updatePlayer).not.toHaveBeenCalled();
    expect(cache.forget).not.toHaveBeenCalledWith("player-reindex:lock");
  });

  it("locks under the job's id and creation time, which a stalled retry keeps", async () => {
    const reindex = { runReindexAll: jest.fn().mockResolvedValue(undefined) };

    await new RefreshAllPlayersJob(reindex as any).process({
      id: "RefreshAllPlayersJob",
      timestamp: 1700000000000,
    } as any);

    expect(reindex.runReindexAll).toHaveBeenCalledWith(
      "RefreshAllPlayersJob:1700000000000",
    );
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
