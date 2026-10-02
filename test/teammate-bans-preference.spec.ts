import { readFileSync } from "fs";
import { join } from "path";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Banned-teammate pushes used to ride the account category, so a player who
// had muted account must not start getting them when they split off.
describe("teammate_bans preference migration", () => {
  let db: SqlTestDb;

  const up = readFileSync(
    join(
      __dirname,
      "../hasura/migrations/default/1890000000100_teammate_bans_preference/up.sql",
    ),
    "utf8",
  );

  const MUTED = "76561199500000031";
  const LISTENING = "76561199500000032";
  const CHOSE_AGAIN = "76561199500000033";

  const teammateBans = async () =>
    (
      await db.postgres.query<Array<{ steam_id: string; enabled: boolean }>>(
        `SELECT steam_id::text AS steam_id, enabled
           FROM public.notification_preferences
          WHERE channel = 'push' AND key = 'teammate_bans'
          ORDER BY steam_id`,
      )
    ).map(({ steam_id, enabled }) => `${steam_id}:${enabled}`);

  beforeAll(async () => {
    db = await bootMigratedDb("TeammateBansPreferenceTest");

    for (const steamId of [MUTED, LISTENING, CHOSE_AGAIN]) {
      await db.postgres.query(
        `INSERT INTO public.players (steam_id, name) VALUES ($1, $2)
         ON CONFLICT (steam_id) DO NOTHING`,
        [steamId, `p${steamId}`],
      );
    }

    for (const [steamId, key, enabled] of [
      [MUTED, "account", false],
      [MUTED, "news", false],
      [LISTENING, "account", true],
      [CHOSE_AGAIN, "account", false],
      [CHOSE_AGAIN, "teammate_bans", true],
    ] as const) {
      await db.postgres.query(
        `INSERT INTO public.notification_preferences
                (steam_id, channel, key, enabled)
              VALUES ($1, 'push', $2, $3)`,
        [steamId, key, enabled],
      );
    }

    await db.postgres.query(up);
    await db.postgres.query(up);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("carries a muted account push over, and leaves every other choice alone", async () => {
    expect(await teammateBans()).toEqual([
      `${MUTED}:false`,
      `${CHOSE_AGAIN}:true`,
    ]);
  });
});
