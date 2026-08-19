import { GamePluginsService } from "./game-plugins.service";

// The registry build picks the Linux asset out of a release; a plugin added by
// hand has to make the same choice, or the operator installs a Windows build
// that unpacks perfectly and then never loads.
describe("GamePluginsService.selectReleaseAsset", () => {
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://github.com/o/r/releases/download/v1/${name}`,
  });

  it("takes the only archive on offer", () => {
    expect(
      GamePluginsService.selectReleaseAsset([asset("Plugin-v1.0.0.zip")])?.name,
    ).toEqual("Plugin-v1.0.0.zip");
  });

  it("prefers the asset that names linux", () => {
    expect(
      GamePluginsService.selectReleaseAsset([
        asset("Plugin-windows.zip"),
        asset("Plugin-linux.zip"),
      ])?.name,
    ).toEqual("Plugin-linux.zip");
  });

  it("refuses a release that only ships builds for another platform", () => {
    expect(
      GamePluginsService.selectReleaseAsset([
        asset("Plugin-win64.zip"),
        asset("Plugin-macos.zip"),
      ]),
    ).toBeNull();
  });

  it("ignores anything that is not an archive", () => {
    expect(
      GamePluginsService.selectReleaseAsset([
        asset("checksums.txt"),
        asset("Plugin.pdb"),
      ]),
    ).toBeNull();
  });

  // "darwin" as a substring of a real name is not a platform tag.
  it("does not mistake a substring for a platform", () => {
    expect(
      GamePluginsService.selectReleaseAsset([asset("darwinism-v2.zip")])?.name,
    ).toEqual("darwinism-v2.zip");
  });
});

describe("GamePluginsService.slugFrom", () => {
  it("makes a slug out of a repository name", () => {
    expect(GamePluginsService.slugFrom("cs2-ss2-inventory-simulator")).toEqual(
      "cs2-ss2-inventory-simulator",
    );
  });

  it("normalises punctuation and case", () => {
    expect(GamePluginsService.slugFrom("MatchZy_Plugin")).toEqual(
      "matchzy-plugin",
    );
  });

  // The version in an asset filename is not part of the plugin's identity;
  // leaving it in would make every release a different plugin.
  it("drops a trailing version", () => {
    expect(GamePluginsService.slugFrom("Retakes-1.2.0")).toEqual("retakes");
  });

  it("drops a v-prefixed version too", () => {
    expect(GamePluginsService.slugFrom("InventorySimulator-v1.2.0.zip")).toEqual(
      "inventorysimulator",
    );
  });

  // A digit that is part of the name, not a release number.
  it("keeps a version-looking name that is the name", () => {
    expect(GamePluginsService.slugFrom("cs2-ss2-inventory-simulator")).toEqual(
      "cs2-ss2-inventory-simulator",
    );
  });

  it("gives up rather than inventing a slug", () => {
    expect(GamePluginsService.slugFrom("...")).toBeUndefined();
  });
});
