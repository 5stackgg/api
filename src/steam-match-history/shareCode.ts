import { ShareCode } from "globaloffensive-sharecode";

export type DecodedShareCode = {
  matchId: bigint;
  outcomeId: bigint;
  tokenId: number;
};

export function decodeShareCode(input: string): DecodedShareCode {
  const stripped = input.replace(/^CSGO-/i, "").replace(/-/g, "");
  if (stripped.length !== 25) {
    throw new Error(`invalid share code length: ${stripped.length}`);
  }

  const invalid = stripped.match(/[^A-HJ-Za-fh-km-z2-9]/);
  if (invalid) {
    throw new Error(`invalid share code character: ${invalid[0]}`);
  }

  // ShareCode deletes every "CSGO" in its input, even one inside the code.
  const decoded = new ShareCode([...stripped].join("-")).decode();
  if (!decoded) {
    throw new Error(`invalid share code: ${input}`);
  }

  return {
    matchId: BigInt(decoded.matchId),
    outcomeId: BigInt(decoded.outcomeId),
    tokenId: Number(decoded.token),
  };
}
