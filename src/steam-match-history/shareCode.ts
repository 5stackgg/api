const DICT = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

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

  let big = 0n;
  for (let i = stripped.length - 1; i >= 0; i--) {
    const idx = DICT.indexOf(stripped[i]);
    if (idx === -1) {
      throw new Error(`invalid share code character: ${stripped[i]}`);
    }
    big = big * 58n + BigInt(idx);
  }

  // Pack the 144-bit value big-endian into 18 bytes, then read each field
  // little-endian — Valve's share-code layout. (No buffer reverse: that
  // scrambled the field boundaries and produced non-canonical match ids.)
  const buf = Buffer.alloc(18);
  let v = big;
  for (let i = 17; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }

  return {
    matchId: buf.readBigUInt64LE(0),
    outcomeId: buf.readBigUInt64LE(8),
    tokenId: buf.readUInt16LE(16),
  };
}
