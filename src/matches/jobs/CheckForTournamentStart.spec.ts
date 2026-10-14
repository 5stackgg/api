import { CheckForTournamentStart } from "./CheckForTournamentStart";

describe("CheckForTournamentStart", () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const hasura = { query: jest.fn(), mutation: jest.fn() };

  let job: CheckForTournamentStart;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-17T18:00:00Z"));
    jest.clearAllMocks();
    hasura.query.mockResolvedValue({ tournaments: [] });
    hasura.mutation.mockResolvedValue({
      update_tournaments: { affected_rows: 1 },
    });
    job = new CheckForTournamentStart(logger as never, hasura as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const updates = () =>
    hasura.mutation.mock.calls.map((call) => call[0].update_tournaments.__args);

  it("starts a closed tournament up to fifteen minutes before its start", async () => {
    await job.process();

    const [closed] = updates();
    expect(closed._set).toEqual({ status: "Live" });
    expect(closed.where._and).toContainEqual({
      status: { _eq: "RegistrationClosed" },
    });
    expect(closed.where._and).toContainEqual({
      start: { _lte: new Date("2026-10-17T18:15:00Z") },
    });
  });

  it("starts an open tournament without check-in once its start has just passed", async () => {
    hasura.query.mockResolvedValue({ tournaments: [{ id: "open-cup" }] });

    await expect(job.process()).resolves.toBe(2);

    const where = hasura.query.mock.calls[0][0].tournaments[0].where;
    expect(where).toEqual({
      status: { _eq: "RegistrationOpen" },
      check_in_required: { _eq: false },
      start: {
        _lte: new Date("2026-10-17T18:00:00Z"),
        _gt: new Date("2026-10-17T17:45:00Z"),
      },
      has_min_teams: { _eq: true },
    });

    const [, open] = updates();
    expect(open.where).toEqual({
      id: { _eq: "open-cup" },
      status: { _eq: "RegistrationOpen" },
      check_in_required: { _eq: false },
    });
    expect(open._set).toEqual({ status: "Live" });
    expect(logger.log).toHaveBeenCalledWith("2 tournaments started");
  });

  it("one open tournament that cannot start does not hold back the rest", async () => {
    hasura.query.mockResolvedValue({
      tournaments: [{ id: "broken-cup" }, { id: "open-cup" }],
    });
    hasura.mutation.mockImplementation(async (mutation) => {
      if (mutation.update_tournaments.__args.where.id?._eq === "broken-cup") {
        throw new Error("odd number of teams in a swiss pool");
      }
      return { update_tournaments: { affected_rows: 1 } };
    });

    await expect(job.process()).resolves.toBe(2);

    expect(updates().map((args) => args.where.id?._eq)).toEqual([
      undefined,
      "broken-cup",
      "open-cup",
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      "cannot start tournament broken-cup",
      expect.any(String),
    );
  });
});
