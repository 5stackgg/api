import { MatchImportService } from "./match-import.service";

// detectMatchType / computeStartingSides are pure private statics; reach them
// directly rather than standing up the whole Nest service with its deps.
const detectMatchType = (
  MatchImportService as unknown as {
    detectMatchType: (players: unknown[]) => string;
  }
).detectMatchType;

const computeStartingSides = (
  MatchImportService as unknown as {
    computeStartingSides: (parsed: unknown) => Map<string, "T" | "CT">;
  }
).computeStartingSides;

describe("MatchImportService.detectMatchType", () => {
  it("uses the majority rank_type, not the first player", () => {
    const players = [
      { steam_id: "1", name: "a", rank_type: 12 }, // outlier
      { steam_id: "2", name: "b", rank_type: 11 },
      { steam_id: "3", name: "c", rank_type: 11 },
      { steam_id: "4", name: "d", rank_type: 11 },
    ];
    expect(detectMatchType(players)).toBe("Premier");
  });

  it("maps rank_type 7 to Wingman", () => {
    expect(
      detectMatchType([{ steam_id: "1", name: "a", rank_type: 7 }]),
    ).toBe("Wingman");
  });

  it("falls back to player count when no rank_type is present", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
    }));
    expect(detectMatchType(five)).toBe("Competitive");
    expect(detectMatchType(five.slice(0, 3))).toBe("Wingman");
  });
});

describe("MatchImportService.computeStartingSides", () => {
  it("reads sides from round 1 only, ignoring post-halftime swaps", () => {
    const parsed = {
      round_ticks: [
        { round: 1, start_tick: 0, end_tick: 100 },
        { round: 13, start_tick: 1300, end_tick: 1400 },
      ],
      kills: [
        { tick: 50, killer: "A", killer_team: "CT", victim: "B", victim_team: "TERRORIST" },
        // C's only kill is after the halftime swap — must not define its side.
        { tick: 1350, killer: "C", killer_team: "CT", victim: "A", victim_team: "TERRORIST" },
      ],
    };
    const sides = computeStartingSides(parsed);
    expect(sides.get("A")).toBe("CT");
    expect(sides.get("B")).toBe("T");
    expect(sides.has("C")).toBe(false);
  });

  it("falls back to all kills when the demo has no round data", () => {
    const parsed = {
      round_ticks: [] as unknown[],
      kills: [
        { tick: 1350, killer: "C", killer_team: "CT", victim: "A", victim_team: "TERRORIST" },
      ],
    };
    const sides = computeStartingSides(parsed);
    expect(sides.get("C")).toBe("CT");
    expect(sides.get("A")).toBe("T");
  });
});
