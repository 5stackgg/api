import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { ScrimsService } from "../src/scrims/scrims.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Matching now runs per team as rows change instead of everyone against
// everyone each minute, so the scoped queries have to find exactly what the
// change could have started matching.
describe("scrim matching (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let notifications: { notifyPlayers: jest.Mock };
  let scrims: ScrimsService;

  beforeAll(async () => {
    db = await bootMigratedDb("ScrimMatchingTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199610000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM team_scrim_alerts");
    await postgres.query("DELETE FROM team_scrim_availability");
    await postgres.query("DELETE FROM team_scrim_settings");
    await postgres.query("DELETE FROM teams");
    notifications = { notifyPlayers: jest.fn().mockResolvedValue(undefined) };
    scrims = new ScrimsService(
      {} as any,
      postgres,
      notifications as any,
      {} as any,
      { get: () => ({ webDomain: "https://5stack.test" }) } as any,
      new Logger("ScrimMatchingTest"),
    );
  });

  const openTeam = async (enabled = true) => {
    const team = await fx.team();
    await postgres.query(
      `INSERT INTO team_scrim_settings (team_id, enabled, regions) VALUES ($1, $2, '{TestA}')`,
      [team.id, enabled],
    );
    return team.id;
  };

  const alert = async (teamId: string) => {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO team_scrim_alerts (team_id, regions) VALUES ($1, '{TestA}') RETURNING id::text`,
      [teamId],
    );
    return row.id;
  };

  const notifiedAlerts = async () =>
    (
      await postgres.query<Array<{ id: string }>>(
        `SELECT id::text FROM team_scrim_alerts WHERE last_notified_at IS NOT NULL ORDER BY id`,
      )
    ).map(({ id }) => id);

  it("alerts only on the team that just opened up", async () => {
    const watcher = await openTeam(false);
    const watching = await alert(watcher);
    const opened = await openTeam();
    const otherWatcher = await openTeam(false);
    const otherAlert = await alert(otherWatcher);

    await scrims.runScrimAlerts({ teamId: opened });

    expect(await notifiedAlerts()).toEqual([watching, otherAlert].sort());

    await postgres.query(
      "UPDATE team_scrim_alerts SET last_notified_at = NULL",
    );
    await scrims.runScrimAlerts({ teamId: watcher });

    expect(await notifiedAlerts()).toEqual([]);
  });

  it("checks only the alert that changed", async () => {
    await openTeam();
    const changed = await alert(await openTeam(false));
    await alert(await openTeam(false));

    await scrims.runScrimAlerts({ alertId: changed });

    expect(await notifiedAlerts()).toEqual([changed]);
  });

  it("finds window openings for open teams only", async () => {
    const open = await openTeam();
    const closed = await openTeam(false);
    for (const teamId of [open, closed]) {
      await postgres.query(
        `INSERT INTO team_scrim_availability (team_id, starts_at, ends_at, recurring_weekly)
         VALUES ($1, now() + interval '45 minutes', now() + interval '3 hours', false)`,
        [teamId],
      );
    }

    const now = new Date();
    const openings = await scrims.scrimWindowOpenings(
      now,
      new Date(now.getTime() + 75 * 60 * 1000),
    );

    expect(openings.map(({ teamId }) => teamId)).toEqual([open]);
    const [{ at }] = openings;
    expect(at.getTime() - now.getTime()).toBeGreaterThan(29 * 60 * 1000);
    expect(at.getTime() - now.getTime()).toBeLessThan(31 * 60 * 1000);
  });
});
