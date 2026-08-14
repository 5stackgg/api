import { directRoomId, parseDirectRoomId } from "./directRoomId";

describe("directRoomId", () => {
  const a = "76561198000000001";
  const b = "76561198000000002";

  it("derives the same room whichever side asks", () => {
    // The entire design rests on this: neither side looks anything up, they
    // both just compute the id. If they disagree, each sits in a room the
    // other never publishes to and nothing appears to be broken.
    expect(directRoomId(a, b)).toBe(directRoomId(b, a));
  });

  it("sorts numerically, not lexicographically", () => {
    // Steam ids are all 17 digits today, so a string sort agrees by accident.
    // It stops agreeing the moment one isn't -- shorter ids sort before longer
    // ones as strings, and after them as numbers.
    expect(directRoomId("900", "1000")).toBe("900:1000");
    expect(["900", "1000"].sort().join(":")).toBe("1000:900");
  });

  it("accepts bigint input", () => {
    expect(directRoomId(BigInt(a), BigInt(b))).toBe(`${a}:${b}`);
  });

  describe("parsing", () => {
    it("round-trips a real room id", () => {
      expect(parseDirectRoomId(directRoomId(b, a))).toEqual([a, b]);
    });

    it("rejects anything that is not a pair of steam ids", () => {
      expect(parseDirectRoomId("only-one")).toBeNull();
      expect(parseDirectRoomId(`${a}:${b}:${a}`)).toBeNull();
      expect(parseDirectRoomId(`${a}:not-a-number`)).toBeNull();
      expect(parseDirectRoomId("")).toBeNull();
    });

    it("rejects a conversation with yourself", () => {
      expect(parseDirectRoomId(`${a}:${a}`)).toBeNull();
    });
  });
});
