import getVetoPattern from "./getVetoPattern";

describe("veto-pattern", () => {
  it("should generate correct pattern for pool size 5 and bestOf 3", () => {
    const expectedPattern = ["Ban", "Ban", "Pick", "Side", "Pick", "Side"];
    const pattern = getVetoPattern(new Array(5), 3);
    expect(pattern).toEqual(expectedPattern);
  });

  it("should generate correct pattern for pool size 7 and bestOf 3", () => {
    const expectedPattern = [
      "Ban",
      "Ban",
      "Pick",
      "Side",
      "Pick",
      "Side",
      "Ban",
      "Ban",
    ];
    const pattern = getVetoPattern(new Array(7), 3);
    expect(pattern).toEqual(expectedPattern);
  });

  it("should generate correct pattern for pool size 7 and bestOf 5", () => {
    const expectedPattern = [
      "Ban",
      "Ban",
      "Pick",
      "Side",
      "Pick",
      "Side",
      "Pick",
      "Side",
      "Pick",
      "Side",
    ];
    const pattern = getVetoPattern(new Array(7), 5);
    expect(pattern).toEqual(expectedPattern);
  });

  it("should generate correct pattern for pool size 24 and bestOf 3", () => {
    const expectedPattern = [
      "Ban",
      "Ban",
      "Pick",
      "Side",
      "Pick",
      "Side",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
    ];
    const pattern = getVetoPattern(new Array(24), 3);
    expect(pattern).toEqual(expectedPattern);
  });

  it("should generate correct pattern for pool size 24 and bestOf 5", () => {
    const expectedPattern = [
      "Ban",
      "Ban",
      "Pick",
      "Side",
      "Pick",
      "Side",
      "Ban",
      "Ban",
      "Pick",
      "Side",
      "Pick",
      "Side",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
      "Ban",
    ];
    const pattern = getVetoPattern(new Array(24), 5);
    expect(pattern).toEqual(expectedPattern);
  });

  it("should generate all bans for bestOf 1", () => {
    const pattern = getVetoPattern(new Array(7), 1);
    const picks = pattern.filter((p) => p === "Pick");
    const sides = pattern.filter((p) => p === "Side");
    expect(picks.length).toBe(0);
    expect(sides.length).toBe(0);
    expect(pattern.length).toBe(6);
    expect(pattern.every((p) => p === "Ban")).toBe(true);
  });

  it("should have picks equal to bestOf minus 1", () => {
    const pattern3 = getVetoPattern(new Array(7), 3);
    const pattern5 = getVetoPattern(new Array(7), 5);
    expect(pattern3.filter((p) => p === "Pick").length).toBe(2);
    expect(pattern5.filter((p) => p === "Pick").length).toBe(4);
  });

  it("should have a Side pick after every Pick", () => {
    const pattern = getVetoPattern(new Array(7), 3);
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] === "Pick") {
        expect(pattern[i + 1]).toBe("Side");
      }
    }
  });
});
