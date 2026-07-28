// One row per player who queued as part of a group. party_key is the
// source's own id for the party (a Valve party id, a FACEIT partyId) and is
// only meaningful within a single match — it is remapped to a uuid on the
// match_lineup_players row.
export type MatchParty = {
  steam_id: string;
  party_key: string;
};
