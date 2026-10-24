jest.mock("../../type-sense/player-reindex.service", () => ({
  PlayerReindexService: class PlayerReindexService {},
}));

import { RefreshPlayerEloRatings } from "./RefreshPlayerEloRatings";

describe("RefreshPlayerEloRatings", () => {
  async function run(rebuilt: boolean) {
    const queue = { add: jest.fn() };
    const job = new RefreshPlayerEloRatings(
      { log: jest.fn() } as any,
      { query: jest.fn().mockResolvedValue([{ rebuilt }]) } as any,
      queue as any,
    );
    await job.process();
    return queue.add;
  }

  it("reindexes every player's search entry once their stored elo is rebuilt", async () => {
    expect(await run(true)).toHaveBeenCalledWith(
      "RefreshAllPlayersJob",
      {},
      expect.objectContaining({ jobId: "RefreshAllPlayersJob" }),
    );
  });

  it("leaves the search index alone when nothing was rebuilt", async () => {
    expect(await run(false)).not.toHaveBeenCalled();
  });
});
