import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, runAsUser, SqlTestDb } from "./utils/sql-test-db";

// The Alerts page draws one bar per period an alert was showing, so every flip
// of is_active has to open or close exactly one.
describe("system_alert_activations", () => {
  let db: SqlTestDb;

  const ADMIN = "76561199500000041";
  const OTHER_ADMIN = "76561199500000042";

  const up = readFileSync(
    join(
      __dirname,
      "../hasura/migrations/default/1890000001110_system_alert_activations/up.sql",
    ),
    "utf8",
  );

  const periods = (alertId: string) =>
    db.postgres.query<
      Array<{
        started_by: string | null;
        ended_by: string | null;
        open: boolean;
        estimated: boolean;
      }>
    >(
      `SELECT started_by_steam_id::text AS started_by,
              ended_by_steam_id::text AS ended_by,
              ended_at IS NULL AS open,
              estimated
         FROM public.system_alert_activations
        WHERE alert_id = $1
        ORDER BY started_at, ended_at NULLS LAST`,
      [alertId],
    );

  const createAlert = async (steamId: string, isActive: boolean) => {
    const [{ id }] = (await runAsUser(
      db.postgres,
      steamId,
      "administrator",
      (query) =>
        query(
          `INSERT INTO public.system_alerts (message, is_active)
           VALUES ('Maintenance tonight', $1) RETURNING id`,
          [isActive],
        ),
    )) as Array<{ id: string }>;
    return id;
  };

  const setActive = (steamId: string, alertId: string, isActive: boolean) =>
    runAsUser(db.postgres, steamId, "administrator", (query) =>
      query("UPDATE public.system_alerts SET is_active = $2 WHERE id = $1", [
        alertId,
        isActive,
      ]),
    );

  beforeAll(async () => {
    db = await bootMigratedDb("SystemAlertActivationsTest");

    for (const steamId of [ADMIN, OTHER_ADMIN]) {
      await db.postgres.query(
        `INSERT INTO public.players (steam_id, name) VALUES ($1, $2)
         ON CONFLICT (steam_id) DO NOTHING`,
        [steamId, `p${steamId}`],
      );
    }
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("opens a period each time an alert goes up and closes it when it comes down, naming who did each", async () => {
    const id = await createAlert(ADMIN, true);
    await setActive(OTHER_ADMIN, id, false);
    await setActive(OTHER_ADMIN, id, true);

    expect(await periods(id)).toEqual([
      {
        started_by: ADMIN,
        ended_by: OTHER_ADMIN,
        open: false,
        estimated: false,
      },
      { started_by: OTHER_ADMIN, ended_by: null, open: true, estimated: false },
    ]);
  });

  it("opens nothing for an alert created switched off", async () => {
    const id = await createAlert(ADMIN, false);

    expect(await periods(id)).toEqual([]);
  });

  it("never opens a second period while one is open", async () => {
    const live = await createAlert(ADMIN, true);
    await setActive(OTHER_ADMIN, live, true);
    await runAsUser(db.postgres, OTHER_ADMIN, "administrator", (query) =>
      query("UPDATE public.system_alerts SET title = 'Moved' WHERE id = $1", [
        live,
      ]),
    );

    expect(await periods(live)).toEqual([
      { started_by: ADMIN, ended_by: null, open: true, estimated: false },
    ]);

    const off = await createAlert(ADMIN, false);
    await db.postgres.query(
      "INSERT INTO public.system_alert_activations (alert_id) VALUES ($1)",
      [off],
    );
    await setActive(OTHER_ADMIN, off, true);

    expect(await periods(off)).toEqual([
      { started_by: null, ended_by: null, open: true, estimated: false },
    ]);
  });

  it("goes with its alert", async () => {
    const id = await createAlert(ADMIN, true);
    await setActive(ADMIN, id, false);
    await setActive(ADMIN, id, true);

    await db.postgres.query("DELETE FROM public.system_alerts WHERE id = $1", [
      id,
    ]);

    expect(await periods(id)).toEqual([]);
  });

  it("backfills a live alert from when it went up, and an alert that is off as an estimate", async () => {
    const [live, off, untouched] = (
      await db.postgres.query<Array<{ id: string }>>(
        `INSERT INTO public.system_alerts (message, is_active, created_at, updated_at)
         VALUES ('live', true, '2026-01-01Z', '2026-02-01Z'),
                ('off', false, '2026-03-01Z', '2026-03-05Z'),
                ('untouched', false, '2026-04-01Z', '2026-04-01Z')
         RETURNING id`,
      )
    ).map(({ id }) => id);

    await db.postgres.query("DELETE FROM public.system_alert_activations");
    await db.postgres.query(up);

    const backfilled = async (alertId: string) =>
      db.postgres.query(
        `SELECT (started_at AT TIME ZONE 'UTC')::date::text AS started,
                (ended_at AT TIME ZONE 'UTC')::date::text AS ended,
                estimated
           FROM public.system_alert_activations
          WHERE alert_id = $1`,
        [alertId],
      );

    expect(await backfilled(live)).toEqual([
      { started: "2026-02-01", ended: null, estimated: false },
    ]);
    expect(await backfilled(off)).toEqual([
      { started: "2026-03-01", ended: "2026-03-05", estimated: true },
    ]);
    expect(await backfilled(untouched)).toEqual([]);
  });
});
