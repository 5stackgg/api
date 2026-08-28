import { UtilityCalloutsService } from "./utility-callouts.service";

const box = (
  min: [number, number, number],
  max: [number, number, number],
) => ({ min, max });

describe("UtilityCalloutsService.calloutAt", () => {
  const callouts = [
    { name: "BombsiteA", boxes: [box([0, 0, 0], [1000, 1000, 200])] },
    { name: "Goose", boxes: [box([100, 100, 0], [300, 300, 200])] },
    { name: "Ramp", boxes: [box([2000, 0, 0], [2400, 400, 200])] },
  ];

  it("names the place a point is standing in", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 800, y: 800, z: 50 }, callouts),
    ).toBe("BombsiteA");
  });

  // The specific name is the one a player would say.
  it("prefers the smaller of two nested volumes", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 200, y: 200, z: 50 }, callouts),
    ).toBe("Goose");
  });

  it("names the place beneath a point resting above it", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 800, y: 800, z: 900 }, callouts),
    ).toBe("BombsiteA");
  });

  // Two places at the same XY on different levels is the Nuke/Vertigo case.
  it("uses Z to separate stacked places", () => {
    const stacked = [
      { name: "Upper", boxes: [box([0, 0, 100], [500, 500, 300])] },
      { name: "Lower", boxes: [box([0, 0, -400], [500, 500, -100])] },
    ];

    expect(
      UtilityCalloutsService.calloutAt({ x: 250, y: 250, z: 200 }, stacked),
    ).toBe("Upper");
    expect(
      UtilityCalloutsService.calloutAt({ x: 250, y: 250, z: -200 }, stacked),
    ).toBe("Lower");
  });

  it("snaps to a nearby place when the point is outside every volume", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 1100, y: 500, z: 50 }, callouts),
    ).toBe("BombsiteA");
  });

  it("says nothing when the nearest place is too far to mean anything", () => {
    expect(
      UtilityCalloutsService.calloutAt({ x: 9000, y: 9000, z: 50 }, callouts),
    ).toBeNull();
  });

  it("says nothing when the map has no callouts", () => {
    expect(UtilityCalloutsService.calloutAt({ x: 0, y: 0, z: 0 }, [])).toBeNull();
  });
});

describe("UtilityCalloutsService.humanize", () => {
  it.each([
    ["BombsiteA", "A Site"],
    ["BombsiteB", "B Site"],
    ["TSpawn", "T Spawn"],
    ["CTSpawn", "CT Spawn"],
    ["Catwalk", "Catwalk"],
    ["LongDoors", "Long Doors"],
    ["back_alley", "back alley"],
  ])("%s reads as %s", (raw, expected) => {
    expect(UtilityCalloutsService.humanize(raw)).toBe(expected);
  });
});

describe("UtilityCalloutsService.normalizeMapName", () => {
  it.each([
    ["de_mirage", "de_mirage"],
    ["DE_Mirage", "de_mirage"],
    ["de_inferno_night", "de_inferno"],
    ["workshop/3121217565/de_thera", "de_thera"],
  ])("%s normalises to %s", (raw, expected) => {
    expect(UtilityCalloutsService.normalizeMapName(raw)).toBe(expected);
  });
});

describe("auto naming", () => {
  const callouts = [
    { name: "TSpawn", boxes: [box([0, 0, 0], [500, 500, 200])] },
    { name: "Middle", boxes: [box([2000, 0, 0], [2500, 500, 200])] },
  ];

  const service = new UtilityCalloutsService(null as never, null as never);

  beforeEach(() => {
    jest.spyOn(service, "forMap").mockResolvedValue(callouts);
  });

  it("says where it lands and where it is thrown from", async () => {
    await expect(
      service.autoName(
        "de_mirage",
        "Smoke",
        { x: 250, y: 250, z: 50 },
        { x: 2250, y: 250, z: 50 },
      ),
    ).resolves.toBe("Middle Smoke from T Spawn");
  });

  it("does not repeat itself when both ends are the same place", async () => {
    await expect(
      service.autoName(
        "de_mirage",
        "Flash",
        { x: 100, y: 100, z: 50 },
        { x: 300, y: 300, z: 50 },
      ),
    ).resolves.toBe("T Spawn Flash");
  });

  it("uses the type label the panel uses", async () => {
    await expect(
      service.autoName(
        "de_mirage",
        "HighExplosive",
        { x: 250, y: 250, z: 50 },
        { x: 2250, y: 250, z: 50 },
      ),
    ).resolves.toBe("Middle HE from T Spawn");
  });

  // Empty rather than a name that says nothing, so the caller's own fallback
  // is still in play.
  it("says nothing when neither end is in a known place", async () => {
    await expect(
      service.autoName(
        "de_mirage",
        "Smoke",
        { x: 90000, y: 90000, z: 50 },
        { x: 95000, y: 95000, z: 50 },
      ),
    ).resolves.toBe("");
  });
});
