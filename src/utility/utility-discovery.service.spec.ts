import {
  UtilityDiscoveryInput,
  UtilityDiscoveryService,
} from "./utility-discovery.service";

describe("UtilityDiscoveryService.normalize", () => {
  const ask = (
    over: Partial<UtilityDiscoveryInput> = {},
  ): UtilityDiscoveryInput => ({
    map_name: "de_mirage",
    target_x: 10,
    target_y: 20,
    target_z: 30,
    radius: 40,
    area: {
      min_x: 100,
      min_y: 100,
      min_z: 0,
      max_x: -100,
      max_y: -100,
      max_z: 64,
    },
    techniques: [{ jump_throw: false }],
    ...over,
  });

  it("orders the area's corners and defaults to a full throw", () => {
    const request = UtilityDiscoveryService.normalize(ask());

    expect(request.area).toEqual({
      min: { x: -100, y: -100, z: 0 },
      max: { x: 100, y: 100, z: 64 },
    });
    expect(request.strengths).toEqual(["Full"]);
  });

  it("clamps the landing radius to what a smoke can mean", () => {
    expect(UtilityDiscoveryService.normalize(ask({ radius: 1 })).radius).toBe(
      UtilityDiscoveryService.MIN_RADIUS,
    );
    expect(
      UtilityDiscoveryService.normalize(ask({ radius: 5000 })).radius,
    ).toBe(UtilityDiscoveryService.MAX_RADIUS);
  });

  it("keeps each technique once and drops the gait of a standing throw", () => {
    const request = UtilityDiscoveryService.normalize(
      ask({
        techniques: [
          { jump_throw: true },
          { direction: "", gait: "run", jump_throw: true },
          { direction: "left", gait: "walk", jump_throw: false },
          { direction: "left", gait: "walk", jump_throw: false },
        ],
      }),
    );

    expect(request.techniques).toEqual([
      { direction: "", gait: "", jump_throw: true },
      { direction: "left", gait: "walk", jump_throw: false },
    ]);
  });

  it("refuses a moving throw with no gait and a direction that is not one", () => {
    expect(() =>
      UtilityDiscoveryService.normalize(
        ask({ techniques: [{ direction: "forward", jump_throw: false }] }),
      ),
    ).toThrow(/walk or a run/);
    expect(() =>
      UtilityDiscoveryService.normalize(
        ask({
          techniques: [{ direction: "up", gait: "run", jump_throw: false }],
        }),
      ),
    ).toThrow(/not a direction/);
    expect(() =>
      UtilityDiscoveryService.normalize(ask({ techniques: [] })),
    ).toThrow(/at least one way to throw/);
  });

  it("refuses more ways to throw than the search takes", () => {
    const techniques = (["forward", "back", "left", "right"] as const).flatMap(
      (direction) =>
        (["walk", "run"] as const).flatMap((gait) =>
          [false, true].map((jump_throw) => ({ direction, gait, jump_throw })),
        ),
    );

    expect(() =>
      UtilityDiscoveryService.normalize(
        ask({
          techniques: [
            { jump_throw: false },
            { jump_throw: true },
            ...techniques,
          ],
        }),
      ),
    ).toThrow(/at most 16/);
  });

  it("keeps only real mouse buttons", () => {
    expect(
      UtilityDiscoveryService.normalize(
        ask({ strengths: ["Half", "Huge", "Half", "Drop"] }),
      ).strengths,
    ).toEqual(["Half", "Drop"]);
  });

  it("refuses a map name that is not one", () => {
    expect(() =>
      UtilityDiscoveryService.normalize(ask({ map_name: "de_mirage; rm" })),
    ).toThrow(/not a map/);
  });
});
