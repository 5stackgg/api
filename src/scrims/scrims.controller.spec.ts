import { ScrimsController } from "./scrims.controller";

describe("ScrimsController events", () => {
  const NOW = new Date("2026-10-20T18:00:00.000Z").getTime();

  let queue: { add: jest.Mock };
  let scrims: {
    scrimWindowOpenings: jest.Mock;
    scrimRequestState: jest.Mock;
    isFinderEnabled: jest.Mock;
    runScrimAlerts: jest.Mock;
  };
  let controller: ScrimsController;

  const woken = () =>
    queue.add.mock.calls.map(([name, data, opts]) => ({
      name,
      data,
      inMs: opts.delay,
    }));

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    queue = { add: jest.fn() };
    scrims = {
      scrimWindowOpenings: jest.fn().mockResolvedValue([]),
      scrimRequestState: jest.fn(),
      isFinderEnabled: jest.fn().mockResolvedValue(true),
      runScrimAlerts: jest.fn(),
    };
    controller = new ScrimsController(scrims as any, queue as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("matches a team against the field as soon as its posting changes", async () => {
    await controller.team_scrim_settings_events({
      op: "UPDATE",
      old: { team_id: "t1" },
      new: { team_id: "t1" },
    });

    expect(woken()).toEqual([
      { name: "MatchScrimTeam", data: { teamId: "t1" }, inMs: 2000 },
    ]);
  });

  it("arms the team for each window that opens before the next hourly pass", async () => {
    scrims.scrimWindowOpenings.mockResolvedValue([
      { teamId: "t1", at: new Date(NOW + 45 * 60 * 1000) },
    ]);

    await controller.team_scrim_availability_events({
      op: "INSERT",
      old: {},
      new: { team_id: "t1" },
    });

    expect(scrims.scrimWindowOpenings).toHaveBeenCalledWith(
      new Date(NOW),
      new Date(NOW + 75 * 60 * 1000),
      "t1",
    );
    expect(woken()).toEqual([
      { name: "MatchScrimTeam", data: { teamId: "t1" }, inMs: 2000 },
      {
        name: "MatchScrimTeam",
        data: { teamId: "t1" },
        inMs: 45 * 60 * 1000 + 2000,
      },
    ]);
  });

  it("expires an open request at its deadline", async () => {
    scrims.scrimRequestState.mockResolvedValue({
      status: "Pending",
      expires_at: new Date(NOW + 24 * 3600 * 1000),
    });

    await controller.team_scrim_request_events({
      op: "INSERT",
      old: {},
      new: { id: "r1", from_team_id: "t1", to_team_id: "t2" },
    });

    expect(woken()).toEqual([
      { name: "ExpireScrimRequests", data: {}, inMs: 24 * 3600 * 1000 + 2000 },
    ]);
  });

  it("matches both teams again once their request stops blocking the pair", async () => {
    scrims.scrimRequestState.mockResolvedValue({
      status: "Declined",
      expires_at: new Date(NOW + 3600 * 1000),
    });

    await controller.team_scrim_request_events({
      op: "UPDATE",
      old: {
        id: "r1",
        from_team_id: "t1",
        to_team_id: "t2",
        status: "Pending",
      },
      new: { id: "r1", status: "Declined" },
    });

    expect(woken().map(({ data }) => data)).toEqual([
      { teamId: "t1" },
      { teamId: "t2" },
    ]);
  });

  it("leaves a pair alone while its request is still open", async () => {
    scrims.scrimRequestState.mockResolvedValue({
      status: "Countered",
      expires_at: new Date(NOW + 3600 * 1000),
    });

    await controller.team_scrim_request_events({
      op: "UPDATE",
      old: {
        id: "r1",
        from_team_id: "t1",
        to_team_id: "t2",
        status: "Pending",
      },
      new: { id: "r1", status: "Countered" },
    });

    expect(woken().map(({ name }) => name)).toEqual(["ExpireScrimRequests"]);
  });

  it("checks only the alert that changed", async () => {
    await controller.team_scrim_alert_events({
      op: "INSERT",
      old: {},
      new: { id: "a1" },
    });

    expect(scrims.runScrimAlerts).toHaveBeenCalledWith({ alertId: "a1" });
  });
});
