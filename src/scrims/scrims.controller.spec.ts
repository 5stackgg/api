import { ScrimsController } from "./scrims.controller";
import { HasuraService } from "../hasura/hasura.service";

describe("ScrimsController events", () => {
  const NOW = new Date("2026-10-20T18:00:00.000Z").getTime();

  let queue: { add: jest.Mock };
  let scrims: {
    scrimWindowOpenings: jest.Mock;
    scrimRequestState: jest.Mock;
    isFinderEnabled: jest.Mock;
    runScrimAlerts: jest.Mock;
    isScrimOpen: jest.Mock;
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
      isScrimOpen: jest.fn().mockResolvedValue(true),
    };
    controller = new ScrimsController(scrims as any, queue as any, {} as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("matches a team against the field as soon as its posting changes, and as its windows open", async () => {
    scrims.scrimWindowOpenings.mockResolvedValue([
      { teamId: "t1", at: new Date(NOW + 5 * 60 * 1000) },
    ]);

    await controller.team_scrim_settings_events({
      op: "UPDATE",
      old: { team_id: "t1" },
      new: { team_id: "t1" },
    });

    expect(woken()).toEqual([
      { name: "MatchScrimTeam", data: { teamId: "t1" }, inMs: 2000 },
      {
        name: "MatchScrimTeam",
        data: { teamId: "t1" },
        inMs: 5 * 60 * 1000 + 2000,
      },
    ]);
  });

  it("re-matches an open team whose roster changed, and leaves a closed one", async () => {
    await controller.scrim_team_roster_events({
      op: "INSERT",
      old: {},
      new: { team_id: "t1" },
    });
    scrims.isScrimOpen.mockResolvedValue(false);
    await controller.scrim_team_roster_events({
      op: "INSERT",
      old: {},
      new: { team_id: "t2" },
    });

    expect(woken().map(({ data }) => data)).toEqual([{ teamId: "t1" }]);
  });

  it("runs a full pass when the finder is switched on, and ignores other settings", async () => {
    await controller.scrim_finder_settings({
      op: "UPDATE",
      old: { name: "public.scrim_finder_enabled" },
      new: { name: "public.scrim_finder_enabled" },
    });
    await controller.scrim_finder_settings({
      op: "UPDATE",
      old: { name: "public.news_enabled" },
      new: { name: "public.news_enabled" },
    });

    expect(woken().map(({ name }) => name)).toEqual(["MatchScrims"]);
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

  it("checks only the alert that changed, on the matcher queue", async () => {
    await controller.team_scrim_alert_events({
      op: "INSERT",
      old: {},
      new: { id: "a1" },
    });

    expect(scrims.runScrimAlerts).not.toHaveBeenCalled();
    expect(woken()).toEqual([
      { name: "RunScrimAlert", data: { alertId: "a1" }, inMs: 2000 },
    ]);
  });
});

describe("ScrimsController scrim requests in a LAN region", () => {
  const user = { name: "Manager", role: "user", steam_id: "100" } as any;

  let scrims: { isManager: jest.Mock; createScrimRequest: jest.Mock };
  let controller: ScrimsController;

  beforeEach(() => {
    scrims = {
      isManager: jest.fn().mockResolvedValue(true),
      createScrimRequest: jest.fn(),
    };
    const hasura = {
      query: jest.fn(async () => ({
        server_regions: [{ value: "Lan" }],
      })),
      assertLanRegionsReachable: (
        ...args: Parameters<HasuraService["assertLanRegionsReachable"]>
      ) =>
        HasuraService.prototype.assertLanRegionsReachable.apply(hasura, args),
    };
    controller = new ScrimsController(scrims as any, {} as any, hasura as any);
  });

  const send = (region: string | undefined, lanRegions: Array<string>) =>
    controller.sendScrimRequest({
      user,
      from_team_id: "a",
      to_team_id: "b",
      proposed_scheduled_at: "2026-10-24T18:00:00.000Z",
      region,
      lanRegions: async () => lanRegions,
    });

  it("refuses a manager off the LAN", async () => {
    await expect(send("lan", [])).rejects.toThrow(
      "You must be on the LAN to play in a LAN region",
    );
    expect(scrims.createScrimRequest).not.toHaveBeenCalled();
  });

  it("sends one for a manager the probe placed on the LAN", async () => {
    await expect(send("Lan", ["Lan"])).resolves.toEqual({ success: true });
    expect(scrims.createScrimRequest).toHaveBeenCalledWith(
      expect.objectContaining({ region: "Lan" }),
    );
  });

  it("leaves online and unset regions alone", async () => {
    await expect(send("US East", [])).resolves.toEqual({ success: true });
    await expect(send(undefined, [])).resolves.toEqual({ success: true });
  });
});
