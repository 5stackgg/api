import { MatchScrims } from "./MatchScrims";

describe("MatchScrims hourly pass", () => {
  const NOW = new Date("2026-10-20T18:37:00.000Z").getTime();

  let queue: { add: jest.Mock };
  let scrims: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    queue = { add: jest.fn() };
    scrims = {
      expireStaleRequests: jest.fn(),
      openRequestExpiries: jest
        .fn()
        .mockResolvedValue([new Date(NOW + 20 * 60 * 1000)]),
      isFinderEnabled: jest.fn().mockResolvedValue(true),
      runScrimAlerts: jest.fn(),
      matchTeams: jest.fn(),
      scrimWindowOpenings: jest
        .fn()
        .mockResolvedValue([
          { teamId: "t1", at: new Date(NOW + 50 * 60 * 1000) },
        ]),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const woken = () =>
    queue.add.mock.calls.map(([name, data, opts]) => [name, data, opts.delay]);

  it("arms the expiries and window openings due before the next pass", async () => {
    await new MatchScrims(scrims as any, queue as any).process();

    expect(scrims.matchTeams).toHaveBeenCalledWith();
    expect(woken()).toEqual([
      ["ExpireScrimRequests", {}, 20 * 60 * 1000 + 2000],
      ["MatchScrimTeam", { teamId: "t1" }, 50 * 60 * 1000 + 2000],
    ]);
  });

  it("still expires requests while the finder is off", async () => {
    scrims.isFinderEnabled.mockResolvedValue(false);

    await new MatchScrims(scrims as any, queue as any).process();

    expect(scrims.expireStaleRequests).toHaveBeenCalled();
    expect(scrims.matchTeams).not.toHaveBeenCalled();
    expect(woken().map(([name]) => name)).toEqual(["ExpireScrimRequests"]);
  });
});
