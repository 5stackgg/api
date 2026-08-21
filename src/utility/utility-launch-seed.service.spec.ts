import { UtilityLaunchSeedService } from "./utility-launch-seed.service";

const TICK_RATE = 64;

// A grenade in free flight is p(t) = p0 + v0*t + a*t^2/2 and nothing else, so a
// synthetic flight is the right oracle here: the derivation has to hand back the
// exact v0 and a that produced the samples.
function flight(
  p0: { x: number; y: number; z: number },
  v0: { x: number; y: number; z: number },
  a: { x: number; y: number; z: number },
  ticks: Array<number> = [0, 1, 2],
  tickRate = TICK_RATE,
) {
  return ticks.map((tick) => {
    const t = tick / tickRate;
    return {
      tick,
      x: p0.x + v0.x * t + (a.x * t * t) / 2,
      y: p0.y + v0.y * t + (a.y * t * t) / 2,
      z: p0.z + v0.z * t + (a.z * t * t) / 2,
    };
  });
}

describe("UtilityLaunchSeedService.derive", () => {
  const p0 = { x: 1420, y: 36, z: -46 };
  const v0 = { x: -640, y: -150, z: 420 };
  const gravity = { x: 0, y: 0, z: -800 };

  it("recovers the exact launch velocity from three samples", () => {
    const seed = UtilityLaunchSeedService.derive(
      flight(p0, v0, gravity),
      TICK_RATE,
    );

    expect(seed).not.toBeNull();
    expect(seed!.position).toEqual(p0);
    expect(seed!.velocity.x).toBeCloseTo(v0.x, 6);
    expect(seed!.velocity.y).toBeCloseTo(v0.y, 6);
    expect(seed!.velocity.z).toBeCloseTo(v0.z, 6);
  });

  it("reports the acceleration the samples actually show", () => {
    const seed = UtilityLaunchSeedService.derive(
      flight(p0, v0, gravity),
      TICK_RATE,
    );

    expect(seed!.acceleration.z).toBeCloseTo(gravity.z, 6);
  });

  // The bug this guards: reading a difference quotient as the velocity at the
  // START of its window instead of the midpoint. That is off by a*dt/2 — half a
  // tick of gravity — which is small enough to look plausible and wrong enough
  // to move the landing point.
  it("is not the naive two-sample quotient", () => {
    const points = flight(p0, v0, gravity);
    const naive = ((points[1].z - points[0].z) * TICK_RATE) as number;
    const seed = UtilityLaunchSeedService.derive(points, TICK_RATE);

    expect(naive).not.toBeCloseTo(v0.z, 3);
    expect(seed!.velocity.z).toBeCloseTo(v0.z, 6);
  });

  it("handles a downsampled path with uneven tick gaps", () => {
    const seed = UtilityLaunchSeedService.derive(
      flight(p0, v0, gravity, [0, 4, 11]),
      TICK_RATE,
    );

    expect(seed!.velocity.x).toBeCloseTo(v0.x, 6);
    expect(seed!.velocity.z).toBeCloseTo(v0.z, 6);
  });

  it("refuses a path that cannot support a derivation", () => {
    expect(
      UtilityLaunchSeedService.derive(flight(p0, v0, gravity, [0, 1]), TICK_RATE),
    ).toBeNull();
    expect(
      UtilityLaunchSeedService.derive(flight(p0, v0, gravity), 0),
    ).toBeNull();
  });

  it("refuses non-monotonic ticks rather than dividing by zero", () => {
    const points = flight(p0, v0, gravity);
    points[1].tick = points[0].tick;

    expect(UtilityLaunchSeedService.derive(points, TICK_RATE)).toBeNull();
  });

  // hasSeed() rejects a zero-length velocity, so writing one would produce a
  // lineup that still reads as unrenderable but no longer looks unseeded.
  it("refuses a motionless flight", () => {
    const seed = UtilityLaunchSeedService.derive(
      flight(p0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
      TICK_RATE,
    );

    expect(seed).toBeNull();
  });
});
