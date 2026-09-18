import { Logger } from "@nestjs/common";
import { FaceitService } from "./faceit.service";

// The leaderboard shows a cached FACEIT rating, so something has to keep the
// cache warm without hammering an API we do not own.
describe("FaceitService.refreshStaleRatings", () => {
  let service: FaceitService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let stalePlayers: Array<{ steam_id: string }>;
  let refreshed: string[];
  let failFor: string[];

  const build = (apiKey: string | null = "key") => {
    hasura = {
      query: jest.fn(async () => ({ players: stalePlayers })),
      mutation: jest.fn(async () => ({})),
    };

    service = new FaceitService(
      { get: () => apiKey } as any,
      { has: jest.fn(), put: jest.fn() } as any,
      hasura as any,
      new Logger("FaceitTest"),
    );

    jest
      .spyOn(service, "refreshPlayer")
      .mockImplementation(async (steamId: string) => {
        if (failFor.includes(steamId)) {
          throw new Error("faceit is down");
        }
        refreshed.push(steamId);
        return true;
      });
  };

  beforeEach(() => {
    stalePlayers = [
      { steam_id: "76561198000000001" },
      { steam_id: "76561198000000002" },
    ];
    refreshed = [];
    failFor = [];
    build();
  });

  it("refreshes every stale player it is given", async () => {
    const result = await service.refreshStaleRatings();

    expect(refreshed.sort()).toEqual([
      "76561198000000001",
      "76561198000000002",
    ]);
    expect(result.refreshed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("only asks for players who already have a faceit account linked", async () => {
    await service.refreshStaleRatings();

    const where = hasura.query.mock.calls[0][0].players.__args.where;

    expect(where.faceit_player_id._is_null).toBe(false);
  });

  it("asks for the least recently refreshed first, in a bounded batch", async () => {
    await service.refreshStaleRatings();

    const args = hasura.query.mock.calls[0][0].players.__args;

    expect(args.order_by).toEqual([{ faceit_updated_at: "asc_nulls_first" }]);
    expect(args.limit).toBeGreaterThan(0);
  });

  it("keeps going when one player fails", async () => {
    failFor = ["76561198000000001"];

    const result = await service.refreshStaleRatings();

    expect(refreshed).toEqual(["76561198000000002"]);
    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(1);
  });

  it("does nothing at all without an api key", async () => {
    build(null);

    const result = await service.refreshStaleRatings();

    expect(hasura.query).not.toHaveBeenCalled();
    expect(result.refreshed).toBe(0);
  });
});
