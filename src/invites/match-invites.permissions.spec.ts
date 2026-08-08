import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("match invite permissions", () => {
  const inviteMetadata = readFileSync(
    join(
      __dirname,
      "../../hasura/metadata/databases/default/tables/public_match_invites.yaml",
    ),
    "utf8",
  );
  const matchesTrigger = readFileSync(
    join(__dirname, "../../hasura/triggers/matches.sql"),
    "utf8",
  );

  it("allows stand-in invites after veto while lineups are still editable", () => {
    expect(inviteMetadata).toContain("- WaitingForCheckIn");
    expect(inviteMetadata).toContain("- WaitingForServer");
    expect(inviteMetadata).toContain("- Veto");
  });

  it("keeps stand-in invites when matches move through post-veto mutable statuses", () => {
    expect(matchesTrigger).toContain(
      "NEW.status NOT IN ('PickingPlayers', 'WaitingForCheckIn', 'WaitingForServer', 'Veto')",
    );
  });
});
