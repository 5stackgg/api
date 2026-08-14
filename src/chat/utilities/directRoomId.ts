// A direct-message room is identified by its two participants rather than by a
// stored row: sort the steam ids ascending and join them with ":". Both sides
// derive the identical id from nothing but the pair, so opening a conversation
// needs no allocation and no lookup.
//
// Sorted as BigInt, deliberately. Steam ids are 17 digits today so a plain
// string sort happens to agree, and would silently disagree the moment one
// isn't -- which is exactly the kind of bug that shows up as "my messages go
// somewhere nobody reads".
export function directRoomId(a: string | bigint, b: string | bigint): string {
  return [BigInt(a), BigInt(b)]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .join(":");
}

export function parseDirectRoomId(id: string): [string, string] | null {
  const parties = id.split(":");

  if (parties.length !== 2) {
    return null;
  }

  if (!parties.every((party) => /^\d{1,20}$/.test(party))) {
    return null;
  }

  if (parties[0] === parties[1]) {
    return null;
  }

  return [parties[0], parties[1]];
}
