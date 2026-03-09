import { isRoleAbove } from "./isRoleAbove";

describe("isRoleAbove", () => {
  it("returns true when roles are equal", () => {
    expect(isRoleAbove("user", "user")).toBe(true);
    expect(isRoleAbove("administrator", "administrator")).toBe(true);
  });

  it("returns true when player role is above the required role", () => {
    expect(isRoleAbove("administrator", "user")).toBe(true);
    expect(isRoleAbove("tournament_organizer", "match_organizer")).toBe(true);
    expect(isRoleAbove("verified_user", "user")).toBe(true);
  });

  it("returns false when player role is below the required role", () => {
    expect(isRoleAbove("user", "administrator")).toBe(false);
    expect(isRoleAbove("user", "verified_user")).toBe(false);
    expect(isRoleAbove("match_organizer", "tournament_organizer")).toBe(false);
  });

  it("respects the full role hierarchy order", () => {
    const roles = [
      "user",
      "verified_user",
      "streamer",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ] as const;

    for (let i = 0; i < roles.length; i++) {
      for (let j = 0; j < roles.length; j++) {
        if (i >= j) {
          expect(isRoleAbove(roles[i], roles[j])).toBe(true);
        } else {
          expect(isRoleAbove(roles[i], roles[j])).toBe(false);
        }
      }
    }
  });
});
