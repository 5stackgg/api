import { BuildMapAssets } from "./BuildMapAssets";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";
import { MapAssetBuildOutcome } from "../map-assets.service";

const published = (
  fields: Partial<MapAssetBuildOutcome> = {},
): MapAssetBuildOutcome => ({
  status: "Published",
  manifest: "25537370/manifest.json",
  maps: { de_mirage: {}, de_nuke: {}, rush_001: {} },
  failed: [],
  failed_view: [],
  error: null,
  previous_build_id: "25400000",
  changes: {
    comparable: true,
    total: 3,
    added: ["rush_001"],
    removed: [],
    rebuilt: [{ map: "de_mirage", reason: "vpk", assets: ["tri"] }],
    unchanged: 1,
  },
  started_at: "2026-09-28T09:31:00Z",
  finished_at: "2026-09-28T09:43:40Z",
  ...fields,
});

describe("BuildMapAssets", () => {
  const auto = { gameServerNodeId: "node-1", trigger: "auto" as const };

  it("notifies once for every outcome", async () => {
    const mapAssets = { build: jest.fn().mockResolvedValue(published()) };
    const notifications = { sendCs2Build: jest.fn() };
    const job = new BuildMapAssets(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      mapAssets as any,
      notifications as any,
    );

    await job.process({
      data: {
        gameServerNodeId: "node-1",
        buildId: "25537370",
        force: true,
        trigger: "manual",
      },
    } as any);

    expect(mapAssets.build).toHaveBeenCalledWith("node-1", "25537370", true);
    expect(notifications.sendCs2Build).toHaveBeenCalledTimes(1);
    expect(notifications.sendCs2Build).toHaveBeenCalledWith(
      "25537370",
      expect.objectContaining({ title: "Map Assets Published" }),
    );
  });

  it("summarises what changed since the previous build", () => {
    const notice = BuildMapAssets.notice("25537370", published(), auto);

    expect(notice.color).toBe(DISCORD_COLORS.GREEN);
    expect(notice.message).toContain("<b>3</b> maps published in 12m 40s.");
    expect(notice.message).toContain(
      "Since build <b>25400000</b>: <b>1</b> rebuilt (<code>de_mirage</code>), <b>1</b> added (<code>rush_001</code>), <b>1</b> unchanged.",
    );
    expect(notice.message).toContain("Automatic run on node-1.");
  });

  it("skips the comparison on the first build", () => {
    const notice = BuildMapAssets.notice(
      "25537370",
      published({ previous_build_id: null, changes: null }),
      auto,
    );

    expect(notice.message).not.toContain("Since build");
  });

  it("lists the maps a partial build could not finish", () => {
    const notice = BuildMapAssets.notice(
      "25537370",
      published({
        status: "Partial",
        failed: ["cs_office"],
        failed_view: ["de_vertigo"],
      }),
      auto,
    );

    expect(notice.title).toBe("Map Assets Published With Failures");
    expect(notice.color).toBe(DISCORD_COLORS.ORANGE);
    expect(notice.message).toContain(
      "<ul><li><code>cs_office</code> — collision or callouts</li><li><code>de_vertigo</code> — view mesh</li></ul>",
    );
  });

  it("reports a failure with a bounded, escaped error", () => {
    const notice = BuildMapAssets.notice(
      "25537370",
      published({
        status: "Failed",
        maps: null,
        error: `<b>${"x".repeat(1000)}`,
      }),
      {
        gameServerNodeId: "node-1",
        trigger: "manual",
        requestedByName: "Luke",
        force: true,
      },
    );

    expect(notice.title).toBe("Map Assets Build Failed");
    expect(notice.color).toBe(DISCORD_COLORS.RED);
    expect(notice.message).toContain("<code>&lt;b&gt;xxx");
    expect(notice.message.length).toBeLessThan(500);
    expect(notice.message).toContain("Forced rebuild by Luke on node-1.");
  });

  it("says the published assets survived a failed forced rebuild", () => {
    const notice = BuildMapAssets.notice(
      "25537370",
      published({ status: "Failed", error: "OOMKilled", kept_published: true }),
      { gameServerNodeId: "node-1", trigger: "manual", force: true },
    );

    expect(notice.title).toBe("Map Assets Build Failed");
    expect(notice.message).toContain("The published assets are unchanged.");
  });

  it.each([
    [0, "0s"],
    [45, "45s"],
    [760, "12m 40s"],
    [7260, "2h 1m"],
  ])("formats %ss as %s", (seconds, expected) => {
    const start = new Date("2026-09-28T00:00:00Z");
    const end = new Date(start.getTime() + seconds * 1000);

    expect(BuildMapAssets.duration(start, end)).toBe(expected);
  });
});
