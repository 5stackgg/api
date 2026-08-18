import { e_player_roles_enum } from "generated";

const roleOrder: e_player_roles_enum[] = [
  "user",
  "verified_user",
  "streamer",
  "moderator",
  "match_organizer",
  "tournament_organizer",
  "administrator",
];

export function isRoleAbove(
  playerRole: e_player_roles_enum,
  role: e_player_roles_enum,
) {
  const playerRoleIndex = roleOrder.indexOf(playerRole);
  const roleIndex = roleOrder.indexOf(role);

  return playerRoleIndex >= roleIndex;
}

// The same answer as isRoleAbove(), as a set rather than a check -- for the
// callers that have to resolve *which* players a role gate admits instead of
// asking about one. Derived from the same order so the two cannot disagree.
export function rolesAtOrAbove(
  role: e_player_roles_enum,
): e_player_roles_enum[] {
  const index = roleOrder.indexOf(role);

  return index === -1 ? [] : roleOrder.slice(index);
}
