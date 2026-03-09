import {
  getMatchmakingQueueCacheKey,
  getMatchmakingLobbyDetailsCacheKey,
  getMatchmakingConformationCacheKey,
  getMatchmakingRankCacheKey,
} from "./cacheKeys";

describe("matchmaking cache keys", () => {
  it("generates queue cache key with region and type", () => {
    const key = getMatchmakingQueueCacheKey("Competitive", "eu-west");
    expect(key).toBe("matchmaking:v20:eu-west:Competitive");
  });

  it("generates lobby details cache key with lobbyId", () => {
    const key = getMatchmakingLobbyDetailsCacheKey("lobby-123");
    expect(key).toBe("matchmaking:v20:details:lobby-123");
  });

  it("generates confirmation cache key with confirmationId", () => {
    const key = getMatchmakingConformationCacheKey("confirm-456");
    expect(key).toBe("matchmaking:v20:confirm-456");
  });

  it("generates rank cache key with region and type", () => {
    const key = getMatchmakingRankCacheKey("Competitive", "eu-west");
    expect(key).toBe("matchmaking:v20:eu-west:Competitive:ranks");
  });

  it("produces different keys for different regions", () => {
    const key1 = getMatchmakingQueueCacheKey("Competitive", "eu-west");
    const key2 = getMatchmakingQueueCacheKey("Competitive", "us-east");
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different types", () => {
    const key1 = getMatchmakingQueueCacheKey("Competitive", "eu-west");
    const key2 = getMatchmakingQueueCacheKey("Wingman", "eu-west");
    expect(key1).not.toBe(key2);
  });

  it("queue and rank keys for same input are different", () => {
    const queueKey = getMatchmakingQueueCacheKey("Competitive", "eu-west");
    const rankKey = getMatchmakingRankCacheKey("Competitive", "eu-west");
    expect(queueKey).not.toBe(rankKey);
  });
});
