import { MatchImportService } from "./match-import.service";

// detectMatchType / computeStartingSides are pure private statics; reach them
// directly rather than standing up the whole Nest service with its deps.
const detectMatchTypeRaw = (
  MatchImportService as unknown as {
    detectMatchType: (parsed: unknown) => string;
  }
).detectMatchType;

// The detector now takes the parsed demo (players + game-rule signals).
const detectMatchType = (
  players: unknown[],
  rules: {
    overtime_enabled?: boolean;
    player_count?: number;
    max_rounds?: number;
    game_mode?: number;
  } = {},
) => detectMatchTypeRaw({ players, ...rules });

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

  it("maps Valve rank types (6=Wingman, 7=Competitive, 11=Premier)", () => {
    expect(detectMatchType([{ steam_id: "1", name: "a", rank_type: 6 }])).toBe(
      "Wingman",
    );
    expect(detectMatchType([{ steam_id: "1", name: "a", rank_type: 7 }])).toBe(
      "Competitive",
    );
    expect(detectMatchType([{ steam_id: "1", name: "a", rank_type: 11 }])).toBe(
      "Premier",
    );
  });

  it("falls back to player count when no rank_type is present", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
    }));
    expect(detectMatchType(five)).toBe("Competitive");
    expect(detectMatchType(five.slice(0, 3))).toBe("Wingman");
  });

  it("classifies 5v5 by overtime when rank_type is absent (CS2 competitive)", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
    }));
    // No overtime -> Competitive; overtime enabled -> Premier.
    expect(detectMatchType(five, { player_count: 10 })).toBe("Competitive");
    expect(
      detectMatchType(five, { player_count: 10, overtime_enabled: true }),
    ).toBe("Premier");
  });

  it("treats rank_type 10 (private/FACEIT) as Competitive, never Premier", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
      rank_type: 10,
    }));
    expect(
      detectMatchType(five, { player_count: 10, overtime_enabled: true }),
    ).toBe("Competitive");
  });

  it("treats 2v2 as Wingman regardless of overtime", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
    }));
    expect(
      detectMatchType(four, { player_count: 4, overtime_enabled: true }),
    ).toBe("Wingman");
  });

  it("classifies Wingman by game_mode/mp_maxrounds even when rank_type reads 7", () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      steam_id: String(i),
      name: "x",
      rank_type: 7,
    }));
    expect(detectMatchType(four, { player_count: 4, game_mode: 2 })).toBe(
      "Wingman",
    );
    expect(detectMatchType(four, { player_count: 4, max_rounds: 16 })).toBe(
      "Wingman",
    );
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
        {
          tick: 50,
          killer: "A",
          killer_team: "CT",
          victim: "B",
          victim_team: "TERRORIST",
        },
        // C's only kill is after the halftime swap — must not define its side.
        {
          tick: 1350,
          killer: "C",
          killer_team: "CT",
          victim: "A",
          victim_team: "TERRORIST",
        },
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
        {
          tick: 1350,
          killer: "C",
          killer_team: "CT",
          victim: "A",
          victim_team: "TERRORIST",
        },
      ],
    };
    const sides = computeStartingSides(parsed);
    expect(sides.get("C")).toBe("CT");
    expect(sides.get("A")).toBe("T");
  });
});
