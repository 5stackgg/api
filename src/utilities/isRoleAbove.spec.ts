import { e_player_roles_enum } from "generated";
import { isRoleAbove, roleRank, rolesAtOrAbove } from "./isRoleAbove";

describe("roleRank", () => {
  it.each([
    ["user", 0],
    ["verified_user", 1],
    ["streamer", 2],
    ["moderator", 3],
    ["match_organizer", 4],
    ["tournament_organizer", 5],
    ["administrator", 6],
    ["unknown_role", 0],
    [null, 0],
    [undefined, 0],
  ])("ranks %s as %i", (role, expected) => {
    expect(roleRank(role as e_player_roles_enum)).toBe(expected);
  });

  it("ranks every role in the order isRoleAbove gates on", () => {
    const roles = rolesAtOrAbove("user");

    expect(roles.map(roleRank)).toEqual(roles.map((_, index) => index));

    for (const a of roles) {
      for (const b of roles) {
        expect(roleRank(a) >= roleRank(b)).toBe(isRoleAbove(a, b));
      }
    }
  });
});
