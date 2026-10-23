import { decodeShareCode } from "./shareCode";

describe("decodeShareCode", () => {
  it.each([
    {
      code: "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK",
      matchId: 3230642215713767580n,
      outcomeId: 3230647599455273103n,
      tokenId: 55788,
    },
    {
      code: "CSGO-vGqmL-vb2x2-nTQtU-e9dco-qWHzN",
      matchId: 3354591898827227340n,
      outcomeId: 3354598500191961136n,
      tokenId: 7780,
    },
  ])(
    "decodes $code to Valve's match id",
    ({ code, matchId, outcomeId, tokenId }) => {
      expect(decodeShareCode(code)).toEqual({ matchId, outcomeId, tokenId });
    },
  );

  it("decodes a code that has CSGO inside it", () => {
    expect(decodeShareCode("CSGO-dDTOM-tT9ur-wEavE-uqERi-LCSGO")).toEqual({
      matchId: 3354591961205914320n,
      outcomeId: 3354591961208377040n,
      tokenId: 63488,
    });
  });

  it("is case-insensitive about the CSGO- prefix", () => {
    expect(decodeShareCode("csgo-GADqf-jjyJ8-cSP2r-smZRo-TO2xK")).toEqual(
      decodeShareCode("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK"),
    );
  });

  it("throws on the wrong length", () => {
    expect(() => decodeShareCode("CSGO-ABC")).toThrow(/length/);
  });

  it.each(["0", "1", "I", "l", "g"])(
    "throws on %s, which is not in Valve's alphabet",
    (character) => {
      expect(() =>
        decodeShareCode(`CSGO-GADq${character}-jjyJ8-cSP2r-smZRo-TO2xK`),
      ).toThrow(/character/);
    },
  );
});
