import { readFileSync } from "fs";
import { join } from "path";
import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// players.ban_ends_at, gag_ends_at and mute_ends_at let is_banned, is_gagged
// and is_muted compare a column with now(): they have to answer what the
// lookups over player_sanctions did, after any write and as sanctions run out.
describe("stored sanction ends", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const SECOND = 1_000;
  const DAY = 86_400_000;
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();

  beforeAll(async () => {
    db = await bootMigratedDb("PlayerSanctionEndsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199770000000n);

    // The checks as they were, reading player_sanctions directly.
    for (const [name, types] of [
      ["banned", "'ban'"],
      ["gagged", "'gag', 'silence'"],
      ["muted", "'mute', 'silence'"],
    ]) {
      await postgres.query(`
        CREATE FUNCTION test_was_${name}(player public.players) RETURNS boolean
        LANGUAGE sql STABLE AS $$
          SELECT EXISTS (
            SELECT 1 FROM player_sanctions ps
            WHERE ps.player_steam_id = player.steam_id
              AND ps.type IN (${types})
              AND ps.deleted_at IS NULL
              AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
          )
        $$`);
    }
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM player_sanctions");
  });

  async function sanction(
    steamId: string,
    type: string,
    removeAt: string | null,
  ): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO player_sanctions (player_steam_id, type, remove_sanction_date)
       VALUES ($1, $2, $3) RETURNING id`,
      [steamId, type, removeAt],
    );
    return row.id;
  }

  async function mismatches(players: string[]) {
    const [row] = await postgres.query<
      Array<{ banned: number; gagged: number; muted: number }>
    >(
      `SELECT
         count(*) FILTER (WHERE is_banned(p) IS DISTINCT FROM test_was_banned(p))::int AS banned,
         count(*) FILTER (WHERE is_gagged(p) IS DISTINCT FROM test_was_gagged(p))::int AS gagged,
         count(*) FILTER (WHERE is_muted(p) IS DISTINCT FROM test_was_muted(p))::int AS muted
       FROM players p WHERE steam_id = ANY ($1::bigint[])`,
      [players],
    );
    return row;
  }

  async function checks(steamId: string) {
    const [row] = await postgres.query<
      Array<{ banned: boolean; gagged: boolean; muted: boolean }>
    >(
      `SELECT is_banned(p) AS banned, is_gagged(p) AS gagged, is_muted(p) AS muted
       FROM players p WHERE steam_id = $1`,
      [steamId],
    );
    return row;
  }

  it("answers what the lookups did, for every player, through random writes", async () => {
    let seed = 20261023;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: T[]): T =>
      items[Math.floor(random() * items.length)];
    const TYPES = ["ban", "gag", "mute", "silence", "warning"];
    const ends = () =>
      pick([null, at(-DAY), at(-SECOND), at(DAY), at(30 * DAY)]);

    const players = await fx.players(10);
    const sanctions: string[] = [];

    for (let index = 0; index < 200; index++) {
      const roll = random();
      let done = "nothing";
      if (roll < 0.4 || sanctions.length === 0) {
        sanctions.push(await sanction(pick(players), pick(TYPES), ends()));
        done = "add";
      } else if (roll < 0.55) {
        await postgres.query(
          "UPDATE player_sanctions SET deleted_at = CASE WHEN deleted_at IS NULL THEN now() ELSE NULL END WHERE id = $1",
          [pick(sanctions)],
        );
        done = "lift or restore";
      } else if (roll < 0.7) {
        await postgres.query(
          "UPDATE player_sanctions SET remove_sanction_date = $2 WHERE id = $1",
          [pick(sanctions), ends()],
        );
        done = "change end";
      } else if (roll < 0.8) {
        await postgres.query(
          "UPDATE player_sanctions SET type = $2 WHERE id = $1",
          [pick(sanctions), pick(TYPES)],
        );
        done = "change type";
      } else if (roll < 0.88) {
        await postgres.query(
          "UPDATE player_sanctions SET player_steam_id = $2 WHERE id = $1",
          [pick(sanctions), pick(players)],
        );
        done = "move to another player";
      } else if (roll < 0.95) {
        await postgres.query("DELETE FROM player_sanctions WHERE id = $1", [
          pick(sanctions),
        ]);
        done = "delete";
      } else {
        await postgres.query(
          `INSERT INTO player_sanctions (player_steam_id, type, remove_sanction_date)
           SELECT steam_id, 'ban', $2 FROM unnest($1::bigint[]) AS steam_id`,
          [players.slice(0, 4), ends()],
        );
        done = "bulk ban";
      }

      expect({ step: index, done, ...(await mismatches(players)) }).toEqual({
        step: index,
        done,
        banned: 0,
        gagged: 0,
        muted: 0,
      });
    }
  });

  it("lets a sanction run out with nothing written", async () => {
    const player = await fx.player();
    await sanction(player, "silence", at(2 * SECOND));
    expect(await checks(player)).toEqual({
      banned: false,
      gagged: true,
      muted: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(await checks(player)).toEqual({
      banned: false,
      gagged: false,
      muted: false,
    });
  });

  it("is backfilled by its migration from the sanctions already there", async () => {
    const [banned, gagged] = await fx.players(2);
    await sanction(banned, "ban", null);
    await sanction(gagged, "gag", at(DAY));
    await postgres.query(
      `UPDATE players SET ban_ends_at = '-infinity', gag_ends_at = '-infinity', mute_ends_at = '-infinity'
       WHERE steam_id = ANY ($1::bigint[])`,
      [[banned, gagged]],
    );

    await postgres.query(
      readFileSync(
        join(
          __dirname,
          "../hasura/migrations/default/1890000001380_players_sanction_ends/up.sql",
        ),
        "utf8",
      ),
    );

    expect(await mismatches([banned, gagged])).toEqual({
      banned: 0,
      gagged: 0,
      muted: 0,
    });
    expect((await checks(banned)).banned).toBe(true);
    expect((await checks(gagged)).gagged).toBe(true);
  });

  it("counts a sanction another transaction is still writing for the same player", async () => {
    const player = await fx.player();

    let commit!: () => void;
    let written!: () => void;
    const writing = new Promise<void>((resolve) => (written = resolve));
    const banning = postgres.transaction(async (client) => {
      await client.query(
        `INSERT INTO player_sanctions (player_steam_id, type) VALUES ($1, 'ban')`,
        [player],
      );
      written();
      await new Promise<void>((resolve) => (commit = resolve));
    });
    await writing;

    const muting = postgres.query(
      `INSERT INTO player_sanctions (player_steam_id, type) VALUES ($1, 'mute')`,
      [player],
    );
    while (
      (
        await postgres.query<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO player_sanctions%'`,
        )
      )[0].n === 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    commit();
    await Promise.all([banning, muting]);

    expect(await checks(player)).toEqual({
      banned: true,
      gagged: false,
      muted: true,
    });
  });

  it("reads the stored columns inline, the way Hasura selects them", async () => {
    const player = await fx.player();
    const plan = (
      await postgres.query<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (VERBOSE, COSTS OFF)
         SELECT public.is_banned("_root.base"), public.is_gagged("_root.base"), public.is_muted("_root.base")
         FROM (SELECT * FROM public.players WHERE steam_id = ANY ($1::bigint[])) AS "_root.base"`,
        [[player]],
      )
    )
      .map((line) => line["QUERY PLAN"])
      .join("\n");

    expect(plan).not.toMatch(/is_banned|is_gagged|is_muted|player_sanctions/);
    expect(plan).toContain("ban_ends_at");
  });
});
