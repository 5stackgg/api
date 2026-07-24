import { e_match_types_enum } from "generated";
import { ExpectedPlayers } from "src/discord-bot/enums/ExpectedPlayers";
import { canPartyQueue, getPartySizeError } from "./partySize";

/**
 * The rule: a party may queue when it fits in one lineup (<= half the match) or
 * fills the whole match exactly. Everything else is unplaceable.
 */
describe("canPartyQueue", () => {
  describe("Duel (2 players, 1v1)", () => {
    const type: e_match_types_enum = "Duel";

    it("allows a solo player (fills one lineup)", () => {
      expect(canPartyQueue(type, 1)).toBe(true);
    });

    it("allows a full party of 2 (both lineups, split in-house)", () => {
      expect(canPartyQueue(type, 2)).toBe(true);
    });

    it.each([3, 4, 5, 10, 11])("rejects a party of %i", (size) => {
      expect(canPartyQueue(type, size)).toBe(false);
    });
  });

  describe("Wingman (4 players, 2v2)", () => {
    const type: e_match_types_enum = "Wingman";

    it.each([1, 2])("allows a party of %i (fits one lineup)", (size) => {
      expect(canPartyQueue(type, size)).toBe(true);
    });

    it("allows a full party of 4", () => {
      expect(canPartyQueue(type, 4)).toBe(true);
    });

    it("rejects a party of 3 — too big for one lineup, too small for two", () => {
      expect(canPartyQueue(type, 3)).toBe(false);
    });

    it.each([5, 6, 10, 11])("rejects a party of %i", (size) => {
      expect(canPartyQueue(type, size)).toBe(false);
    });
  });

  describe("Competitive (10 players, 5v5)", () => {
    const type: e_match_types_enum = "Competitive";

    it.each([1, 2, 3, 4, 5])(
      "allows a party of %i (fits one lineup)",
      (size) => {
        expect(canPartyQueue(type, size)).toBe(true);
      },
    );

    it("allows a full party of 10", () => {
      expect(canPartyQueue(type, 10)).toBe(true);
    });

    it.each([6, 7, 8, 9])(
      "rejects a party of %i — between one lineup and a full match",
      (size) => {
        expect(canPartyQueue(type, size)).toBe(false);
      },
    );

    it.each([11, 12, 15, 20])(
      "rejects a party of %i — larger than the match itself",
      (size) => {
        expect(canPartyQueue(type, size)).toBe(false);
      },
    );
  });

  describe("Premier / Faceit (10 players)", () => {
    const tenPlayerTypes: e_match_types_enum[] = ["Premier", "Faceit"];

    it.each(tenPlayerTypes)(
      "%s follows the same 1-5 or exactly 10 rule",
      (type) => {
        expect(canPartyQueue(type, 5)).toBe(true);
        expect(canPartyQueue(type, 6)).toBe(false);
        expect(canPartyQueue(type, 10)).toBe(true);
        expect(canPartyQueue(type, 11)).toBe(false);
      },
    );
  });

  describe("the party sizes from the queue matrix", () => {
    const matchmakingTypes: e_match_types_enum[] = [
      "Duel",
      "Wingman",
      "Competitive",
    ];

    const queueableTypes = (size: number) =>
      matchmakingTypes.filter((type) => canPartyQueue(type, size));

    it("1 — every mode", () => {
      expect(queueableTypes(1)).toEqual(["Duel", "Wingman", "Competitive"]);
    });

    it("2 — every mode (full Duel, half a Wingman)", () => {
      expect(queueableTypes(2)).toEqual(["Duel", "Wingman", "Competitive"]);
    });

    it("3 — Competitive only", () => {
      expect(queueableTypes(3)).toEqual(["Competitive"]);
    });

    it("4 — Wingman and Competitive", () => {
      expect(queueableTypes(4)).toEqual(["Wingman", "Competitive"]);
    });

    it("5 — Competitive only", () => {
      expect(queueableTypes(5)).toEqual(["Competitive"]);
    });

    it.each([6, 7, 8, 9])("%i — nothing is queueable", (size) => {
      expect(queueableTypes(size)).toEqual([]);
    });

    it("10 — Competitive only", () => {
      expect(queueableTypes(10)).toEqual(["Competitive"]);
    });

    it.each([11, 12, 20])(
      "%i — nothing is queueable, over every match size",
      (size) => {
        expect(queueableTypes(size)).toEqual([]);
      },
    );
  });

  describe("degenerate sizes", () => {
    it.each([0, -1])("rejects a party of %i", (size) => {
      expect(canPartyQueue("Competitive", size)).toBe(false);
    });
  });

  it("stays in sync with ExpectedPlayers for every match type", () => {
    for (const [type, expected] of Object.entries(ExpectedPlayers)) {
      const matchType = type as e_match_types_enum;

      expect(canPartyQueue(matchType, expected / 2)).toBe(true);
      expect(canPartyQueue(matchType, expected / 2 + 1)).toBe(
        expected / 2 + 1 === expected,
      );
      expect(canPartyQueue(matchType, expected)).toBe(true);
      expect(canPartyQueue(matchType, expected + 1)).toBe(false);
    }
  });
});

describe("getPartySizeError", () => {
  it("returns nothing for a queueable party", () => {
    expect(getPartySizeError("Competitive", 5)).toBeUndefined();
    expect(getPartySizeError("Wingman", 4)).toBeUndefined();
  });

  it("names the type, both valid sizes, and the actual party size", () => {
    const error = getPartySizeError("Competitive", 7);

    expect(error).toContain("Competitive");
    expect(error).toContain("5 or fewer");
    expect(error).toContain("exactly 10");
    expect(error).toContain("You have 7");
  });

  it("reports Wingman thresholds", () => {
    expect(getPartySizeError("Wingman", 3)).toContain(
      "2 or fewer players, or exactly 4 players",
    );
  });

  it("reports Duel thresholds", () => {
    expect(getPartySizeError("Duel", 3)).toContain(
      "1 or fewer players, or exactly 2 players",
    );
  });
});
