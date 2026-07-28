// party_key is the source's own id and is only unique within one match; it is
// remapped to a uuid before being stored.
export type MatchParty = {
  steam_id: string;
  party_key: string;
};
