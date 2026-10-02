import { CommunityStatsService } from "./community-stats.service";

const SERVER_ID = "11111111-1111-1111-1111-111111111111";

function fakeRedis() {
  const strings = new Map<string, string>();

  return {
    get: async (key: string) => strings.get(key) ?? null,
    exists: async (key: string) => (strings.has(key) ? 1 : 0),
    set: async (key: string, value: string, ...args: Array<unknown>) => {
      if (args.includes("NX") && strings.has(key)) {
        return null;
      }
      strings.set(key, value);
      return "OK";
    },
    eval: async (_script: string, _keys: number, key: string, token: string) => {
      if (strings.get(key) === token) {
        strings.delete(key);
      }
      return 1;
    },
  };
}

describe("CommunityStatsService.serverStats", () => {
  // The activity chart and leaderboard are cached for minutes, so a session
  // that had run 20 seconds when the page first loaded kept reading 20s.
  it("rebuilds a server's cached stats once its roster changes", async () => {
    let weekSeconds = 20;
    let version = "0";

    const service = new CommunityStatsService(
      { warn: jest.fn() } as never,
      {
        query: jest.fn(async (sql: string) => {
          if (sql.includes("FROM public.servers s")) {
            return [{ id: SERVER_ID, label: "Prophunt", max_players: 24 }];
          }
          if (sql.includes("week_players")) {
            return [{ week_players: 1, week_seconds: weekSeconds, online: 0 }];
          }
          if (sql.includes("all_time_players")) {
            return [{ all_time_players: 1, tracked_since: null }];
          }
          return [];
        }),
      } as never,
      {
        version: async () => version,
        liveCounts: async () => ({}),
      } as never,
      { getConnection: () => fakeRedis() } as never,
    );

    expect((await service.serverStats(SERVER_ID))?.week_seconds).toBe(20);

    weekSeconds = 180;
    expect((await service.serverStats(SERVER_ID))?.week_seconds).toBe(20);

    version = "1";
    expect((await service.serverStats(SERVER_ID))?.week_seconds).toBe(180);
  });
});
