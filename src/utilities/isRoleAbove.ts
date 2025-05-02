import { e_player_roles_enum } from "generated";

const roleOrder: e_player_roles_enum[] = [
    "user",
    "verified_user",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ];

export function isRoleAbove(playerRole: e_player_roles_enum, role: e_player_roles_enum) {
    const playerRoleIndex = roleOrder.indexOf(playerRole);
    const roleIndex = roleOrder.indexOf(role);

    return playerRoleIndex >= roleIndex;
  } 