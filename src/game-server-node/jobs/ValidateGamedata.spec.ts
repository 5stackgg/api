import { ValidateGamedata } from "./ValidateGamedata";
import { DISCORD_COLORS } from "src/notifications/utilities/constants";
import {
  GamedataValidationChanges,
  GamedataValidationEntry,
} from "../game-server-node.service";

const entry = (
  signature: string,
  fields: Partial<GamedataValidationEntry> = {},
): GamedataValidationEntry => ({
  set: "fivestack",
  signature,
  kind: "signature",
  count: 0,
  runtimes: ["swiftlys2", "counterstrikesharp"],
  ...fields,
});

const noChanges = (
  fields: Partial<GamedataValidationChanges> = {},
): GamedataValidationChanges => ({
  comparable: true,
  counts: { checked: 10, broken: 0, warnings: 0, skipped: 0 },
  newly_broken: [],
  fixed: [],
  new_warnings: [],
  cleared_warnings: [],
  ...fields,
});

describe("ValidateGamedata", () => {
  let gameServerNodeService: { validateGamedata: jest.Mock };
  let mapAssets: { queueBuild: jest.Mock };
  let notifications: { sendCs2Build: jest.Mock };
  let job: ValidateGamedata;

  beforeEach(() => {
    gameServerNodeService = {
      validateGamedata: jest.fn().mockResolvedValue({
        result: { status: "pass", broken: [] },
        previousBuildId: null,
        changes: null,
      }),
    };
    mapAssets = { queueBuild: jest.fn().mockResolvedValue(true) };
    notifications = { sendCs2Build: jest.fn().mockResolvedValue(undefined) };
    job = new ValidateGamedata(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      notifications as any,
      gameServerNodeService as any,
      mapAssets as any,
    );
  });

  const run = (data: Record<string, unknown>) =>
    job.process({
      id: "validate.25537370.manual",
      data: { gameServerNodeId: "node-1", buildId: 25537370, ...data },
    } as any);

  it("starts the chained map-assets build once validation finishes", async () => {
    const order: Array<string> = [];
    gameServerNodeService.validateGamedata.mockImplementation(async () => {
      order.push("validate");
      return {
        result: { status: "pass", broken: [] },
        previousBuildId: null,
        changes: null,
      };
    });
    mapAssets.queueBuild.mockImplementation(async () => {
      order.push("map-assets");
      return true;
    });

    await run({ buildMapAssets: true });

    expect(order).toEqual(["validate", "map-assets"]);
    expect(mapAssets.queueBuild).toHaveBeenCalledWith("node-1", 25537370);
  });

  it("still starts it when validation fails outright", async () => {
    gameServerNodeService.validateGamedata.mockRejectedValue(
      new Error("k8s down"),
    );

    await expect(run({ buildMapAssets: true })).rejects.toThrow("k8s down");
    expect(mapAssets.queueBuild).toHaveBeenCalledWith("node-1", 25537370);
  });

  it("leaves map assets alone for a validation nobody chained to", async () => {
    await run({});

    expect(mapAssets.queueBuild).not.toHaveBeenCalled();
  });

  it("passes who asked for the run through to the record", async () => {
    await run({
      trigger: "manual",
      requestedBy: "76561198000000001",
    });

    expect(gameServerNodeService.validateGamedata).toHaveBeenCalledWith(
      "node-1",
      25537370,
      "public",
      { trigger: "manual", requestedBy: "76561198000000001" },
      "validate.25537370.manual",
    );
  });

  it("posts the result to the build's channel", async () => {
    await run({ trigger: "auto" });

    expect(notifications.sendCs2Build).toHaveBeenCalledWith(
      25537370,
      expect.objectContaining({
        title: "Gamedata Validation Passed",
        color: DISCORD_COLORS.GREEN,
      }),
    );
  });

  it("sends nothing when another run held the lock", async () => {
    gameServerNodeService.validateGamedata.mockResolvedValue(null);

    await run({});

    expect(notifications.sendCs2Build).not.toHaveBeenCalled();
  });

  describe("notice", () => {
    const auto = { gameServerNodeId: "node-1", trigger: "auto" as const };

    it("marks broken entries that are new since the previous build", () => {
      const connect = entry("ConnectClient");
      const old = entry("OldBreak", { runtimes: ["counterstrikesharp"] });
      const notice = ValidateGamedata.notice(
        25537370,
        {
          result: { status: "fail", broken: [connect, old] },
          previousBuildId: 25400000,
          changes: noChanges({
            newly_broken: [
              {
                set: "fivestack",
                kind: "signature",
                signature: "ConnectClient",
                runtimes: [],
                previous_count: 1,
                count: 0,
              },
            ],
          }),
        },
        auto,
      );

      expect(notice.title).toBe("Gamedata Validation Failed");
      expect(notice.color).toBe(DISCORD_COLORS.RED);
      expect(notice.message).toContain(
        "(<b>1</b> new, <b>0</b> fixed since build <b>25400000</b>)",
      );
      expect(notice.message).toContain(
        "<code>ConnectClient</code> — fivestack <i>new</i>",
      );
      expect(notice.message).toContain(
        "<code>OldBreak</code> — fivestack</li>",
      );
      expect(notice.message).toContain("Automatic run on node-1.");
    });

    it("escapes everything the validator reports", () => {
      const notice = ValidateGamedata.notice(
        25537370,
        {
          result: {
            status: "fail",
            broken: [entry("<img src=x onerror=alert(1)>", { set: "<b>" })],
          },
          previousBuildId: null,
          changes: null,
        },
        auto,
      );

      expect(notice.message).not.toContain("<img");
      expect(notice.message).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(notice.message).toContain("— &lt;b&gt;");
    });

    it("escapes the error of a run that could not validate", () => {
      const notice = ValidateGamedata.notice(
        25537370,
        {
          result: { status: "error", broken: [], error: "<script>" },
          previousBuildId: null,
          changes: null,
        },
        {
          gameServerNodeId: "node-1",
          trigger: "manual",
          requestedByName: "Luke",
        },
      );

      expect(notice.title).toBe("Gamedata Validation Error");
      expect(notice.message).toContain("<code>&lt;script&gt;</code>");
      expect(notice.message).toContain("Manual run by Luke on node-1.");
    });

    it("caps a long list", () => {
      const broken = Array.from({ length: 14 }, (_, index) =>
        entry(`Sig${index}`, { runtimes: ["swiftlys2"] }),
      );
      const notice = ValidateGamedata.notice(
        25537370,
        {
          result: { status: "fail", broken },
          previousBuildId: null,
          changes: null,
        },
        auto,
      );

      expect(notice.message.match(/<li><code>/g)).toHaveLength(10);
      expect(notice.message).toContain("<li>…and 4 more</li>");
    });

    it("lists what a passing build fixed", () => {
      const notice = ValidateGamedata.notice(
        25537370,
        {
          result: { status: "pass", broken: [] },
          previousBuildId: 25400000,
          changes: noChanges({
            fixed: [
              {
                set: "fivestack",
                kind: "signature",
                signature: "ConnectClient",
                runtimes: [],
                previous_count: 0,
                count: 1,
              },
            ],
          }),
        },
        auto,
      );

      expect(notice.color).toBe(DISCORD_COLORS.GREEN);
      expect(notice.message).toContain(
        "<b>1</b> fixed since build <b>25400000</b>: <code>ConnectClient</code>.",
      );
    });

    it("warns about signatures that stopped being unique", () => {
      const notice = ValidateGamedata.notice(
        25537370,
        {
          result: {
            status: "pass",
            broken: [],
            warnings: [entry("SwitchTeam", { count: 2, ok: true })],
          },
          previousBuildId: null,
          changes: null,
        },
        auto,
      );

      expect(notice.title).toBe("Gamedata Validation Warning");
      expect(notice.message).toContain(
        "<code>SwitchTeam</code> — fivestack (2 matches)",
      );
    });
  });
});
