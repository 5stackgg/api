import { shuffleSplit } from "./shuffleSplit";

describe("shuffleSplit", () => {
  const players = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}` }));

  it("splits evenly and uses every item exactly once", () => {
    const [team1, team2] = shuffleSplit(players);

    expect(team1).toHaveLength(5);
    expect(team2).toHaveLength(5);
    expect(new Set([...team1, ...team2]).size).toBe(10);
  });

  it("does not mutate the input", () => {
    const snapshot = [...players];
    shuffleSplit(players);
    expect(players).toEqual(snapshot);
  });

  it("splits a wingman party", () => {
    const [team1, team2] = shuffleSplit(players.slice(0, 4));
    expect(team1).toHaveLength(2);
    expect(team2).toHaveLength(2);
  });

  it("is uniform, unlike the sort based shuffle it replaced", () => {
    // sort(() => Math.random() - 0.5) leaves items near where they started, so
    // p0 lands on team 1 far more often than half the time
    const counts = new Map<string, number>();
    const runs = 20000;

    for (let i = 0; i < runs; i++) {
      const [team1] = shuffleSplit(players);
      for (const player of team1) {
        counts.set(player.id, (counts.get(player.id) ?? 0) + 1);
      }
    }

    // every player should land on team 1 about half the time
    for (const player of players) {
      expect(counts.get(player.id) / runs).toBeGreaterThan(0.45);
      expect(counts.get(player.id) / runs).toBeLessThan(0.55);
    }
  });
});
