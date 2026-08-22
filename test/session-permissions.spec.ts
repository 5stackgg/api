import { PostgresService } from "./../src/postgres/postgres.service";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// v_role_permissions resolves the settings-driven minimum-role gates
// (public.create_matches_role and friends) in one place, so the table
// permissions need a single inherited rule instead of one hand-written role
// list per role. The lists it replaced had all drifted the same way: none of
// them included 'moderator', so selecting that role denied everyone below an
// administrator. The moderator cases below are that regression.
describe("session permission gates (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;

  const ROLES = [
    "guest",
    "user",
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ];

  beforeAll(async () => {
    db = await bootMigratedDb("SessionPermissionsTest");
    postgres = db.postgres;
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  const setGate = (value: string | null) =>
    value === null
      ? postgres.query(
          "DELETE FROM settings WHERE name = 'public.create_matches_role'",
        )
      : postgres.query(
          `INSERT INTO settings (name, value) VALUES ('public.create_matches_role', $1)
           ON CONFLICT (name) DO UPDATE SET value = $1`,
          [value],
        );

  // Mirrors what the permission does: match the row by role, the way Hasura
  // does after substituting X-Hasura-Role.
  const rolesThatCanCreate = async () => {
    const allowed: Array<string> = [];

    for (const role of ROLES) {
      const rows = await postgres.query<Array<{ can_create_matches: boolean }>>(
        "SELECT can_create_matches FROM v_role_permissions WHERE role = $1",
        [role],
      );

      if (rows[0]?.can_create_matches) {
        allowed.push(role);
      }
    }

    return allowed;
  };

  it("defaults to user when the setting row is absent", async () => {
    await setGate(null);

    expect(await rolesThatCanCreate()).toEqual([
      "user",
      "verified_user",
      "streamer",
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ]);
  });

  it("admits moderator and above when the gate is moderator", async () => {
    await setGate("moderator");

    expect(await rolesThatCanCreate()).toEqual([
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ]);
  });

  it("admits only administrator when the gate is administrator", async () => {
    await setGate("administrator");

    expect(await rolesThatCanCreate()).toEqual(["administrator"]);
  });

  // guest is not a row in e_player_roles, so it can never match the permission.
  it("never admits guest", async () => {
    for (const gate of ROLES.filter((role) => role !== "guest")) {
      await setGate(gate);
      expect(await rolesThatCanCreate()).not.toContain("guest");
    }
  });
});
