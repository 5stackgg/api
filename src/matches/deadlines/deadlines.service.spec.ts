import { DeadlinesService } from "./deadlines.service";

describe("DeadlinesService", () => {
  const NOW = new Date("2026-10-20T12:00:00.000Z").getTime();
  const MINUTE = 60 * 1000;

  let rows: Array<Record<string, unknown>>;
  let postgres: { query: jest.Mock };
  let queue: { add: jest.Mock; getDelayed: jest.Mock };
  let vetoQueue: { add: jest.Mock; getDelayed: jest.Mock };
  let service: DeadlinesService;

  // Each wake-up as the job it wakes and how far from now it fires.
  const wakes = (target = queue) =>
    target.add.mock.calls
      .map(([name, , opts]) => [name, opts.delay])
      .sort(([a, x], [b, y]) => String(a).localeCompare(String(b)) || x - y);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    rows = [];
    postgres = { query: jest.fn(async () => rows) };
    queue = { add: jest.fn(), getDelayed: jest.fn().mockResolvedValue([]) };
    vetoQueue = {
      add: jest.fn(),
      getDelayed: jest.fn().mockResolvedValue([]),
    };
    service = new DeadlinesService(
      { debug: jest.fn() } as any,
      postgres as any,
      queue as any,
      vetoQueue as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("opens check-in for a scheduled match 15 minutes ahead of its time", async () => {
    rows = [
      {
        id: "m",
        status: "Scheduled",
        scheduled_at: new Date(NOW + 60 * MINUTE),
        cancels_at: null,
        veto_pick_expires_at: null,
      },
    ];

    await service.armMatch("m");

    expect(wakes()).toEqual([["CheckForScheduledMatches", 45 * MINUTE + 2000]]);
  });

  it("wakes the expiry sweep a minute early to force start a full lobby, and at the deadline", async () => {
    rows = [
      {
        id: "m",
        status: "WaitingForCheckIn",
        scheduled_at: null,
        cancels_at: new Date(NOW + 15 * MINUTE),
        veto_pick_expires_at: null,
      },
    ];

    await service.armMatch("m");

    expect(wakes()).toEqual([
      ["CancelExpiredMatches", 14 * MINUTE + 2000],
      ["CancelExpiredMatches", 15 * MINUTE + 2000],
    ]);
  });

  it("runs a deadline that has already passed within two seconds", async () => {
    rows = [
      {
        id: "m",
        status: "Live",
        scheduled_at: null,
        cancels_at: new Date(NOW - 5 * MINUTE),
        veto_pick_expires_at: null,
      },
    ];

    await service.armMatch("m");

    expect(wakes()).toEqual([
      ["CancelExpiredMatches", 2000],
      ["CancelExpiredMatches", 2000],
    ]);
    expect(
      new Set(queue.add.mock.calls.map(([, , opts]) => opts.jobId)).size,
    ).toBe(1);
  });

  it("leaves a canceled match alone", async () => {
    rows = [
      {
        id: "m",
        status: "Canceled",
        scheduled_at: null,
        cancels_at: new Date(NOW + 5 * MINUTE),
        veto_pick_expires_at: null,
      },
    ];

    await service.armMatch("m");

    expect(wakes()).toEqual([]);
  });

  it("wakes every tournament sweep at the moments each one acts", async () => {
    const start = NOW + 120 * MINUTE;
    rows = [
      {
        id: "t",
        status: "RegistrationOpen",
        start: new Date(start),
        check_in_required: true,
        check_in_opens_before_minutes: 60,
        check_in_ends_at: new Date(start - 15 * MINUTE),
      },
    ];

    await service.armTournament("t");

    const at = (ms: number) => ms - NOW + 2000;
    expect(wakes()).toEqual([
      ["CancelInvalidTournaments", at(start)],
      ["CheckForScheduledMatches", at(start + 61 * 1000)],
      ["CheckForTournamentStart", at(start - 15 * MINUTE)],
      ["CheckForTournamentStart", at(start)],
      ["ProcessTournamentCheckIn", at(start - 60 * MINUTE)],
      ["ProcessTournamentCheckIn", at(start - 20 * MINUTE)],
      ["ProcessTournamentCheckIn", at(start - 15 * MINUTE)],
      ["ProcessTournamentCheckIn", at(start)],
    ]);
  });

  it("schedules a live tournament's due brackets straight away", async () => {
    rows = [
      {
        id: "t",
        status: "Live",
        start: new Date(NOW - 5 * MINUTE),
        check_in_required: false,
        check_in_opens_before_minutes: 60,
        check_in_ends_at: null,
      },
    ];

    await service.armTournament("t");

    expect(wakes()).toContainEqual([
      "CheckForScheduledTournamentBrackets",
      2000,
    ]);
  });

  it("schedules a bracket's match 15 minutes ahead of its time", async () => {
    rows = [{ scheduled_at: new Date(NOW + 30 * MINUTE) }];

    await service.armBracket("b");

    expect(wakes()).toEqual([
      ["CheckForScheduledTournamentBrackets", 15 * MINUTE + 2000],
    ]);
  });

  it("arms the veto timer for the turn that is open, replacing the last one", async () => {
    const previous = {
      id: "match.m.veto-pick.2",
      remove: jest.fn().mockResolvedValue(undefined),
    };
    vetoQueue.getDelayed.mockResolvedValue([
      previous,
      { id: "match.other.veto-pick.0", remove: jest.fn() },
    ]);
    rows = [{ pick_count: 3 }];

    await service.scheduleVetoPickTimeout("m", new Date(NOW + 30 * 1000));

    expect(previous.remove).toHaveBeenCalled();
    expect(vetoQueue.add).toHaveBeenCalledWith(
      "AutoPickExpiredVeto",
      { matchId: "m", pickCount: 3 },
      expect.objectContaining({
        jobId: "match.m.veto-pick.3",
        delay: 30 * 1000,
      }),
    );
  });
});
