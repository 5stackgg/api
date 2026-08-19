import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  NadeLineupsService,
  NadeServerContext,
} from "./../src/nades/nade-lineups.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// verified_at used to be a moderator's manual claim, which at library scale
// means it is null forever and the badge means nothing. It is now derived from
// the only evidence the platform actually collects: distinct players who have
// mastered the lineup, five consecutive throws each, scored by the API against
// the stored landing point.
//
// Two properties carry the whole thing and both are asserted below: it counts
// PLAYERS rather than rows, and it can only ever turn verification on.
describe("nade lineup verification (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const LAND = { x: -560, y: 320, z: -140 };

  beforeAll(async () => {
    db = await bootMigratedDb("NadeVerifyTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199630000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM nade_lineup_progress");
    await postgres.query("DELETE FROM nade_lineups");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "UPDATE settings SET value = '3' WHERE name = 'public.nade_verify_masteries'",
    );
  });

  function makeService(): NadeLineupsService {
    const store = new Map<string, unknown>();

    return new NadeLineupsService(
      new Logger("NadeVerifyTest"),
      postgres,
      {
        uploadTrajectory: jest.fn(async (): Promise<string> => "key"),
        removeTrajectories: jest.fn(async (): Promise<void> => undefined),
      } as unknown as never,
      {
        get: jest.fn(async (key: string, fallback?: unknown) =>
          store.has(key) ? store.get(key) : fallback,
        ),
        put: jest.fn(async (key: string, value: unknown) => {
          store.set(key, value);
          return true;
        }),
      } as unknown as never,
    );
  }

  async function setting(name: string, value: string) {
    await postgres.query(
      `INSERT INTO settings (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`,
      [name, value],
    );
  }

  async function insertLineup(
    author: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      map_name: "de_mirage",
      nade_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: LAND.x,
      land_y: LAND.y,
      land_z: LAND.z,
      name: "Window from T spawn",
      visibility: "Public",
      author_steam_id: author,
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO nade_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  async function master(lineupId: string, steamId: string) {
    await postgres.query(
      `INSERT INTO nade_lineup_progress
         (nade_lineup_id, steam_id, attempts, successes, current_streak,
          best_streak, mastered_at)
       VALUES ($1::uuid, $2::bigint, 5, 5, 5, 5, now())`,
      [lineupId, steamId],
    );
  }

  async function verifiedAt(lineupId: string): Promise<Date | null> {
    const [row] = await postgres.query<Array<{ verified_at: Date | null }>>(
      "SELECT verified_at FROM nade_lineups WHERE id = $1::uuid",
      [lineupId],
    );
    return row.verified_at;
  }

  describe("deriving verification", () => {
    it("verifies on the Nth distinct master and not before", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b, c] = await fx.players(3);

      await master(lineup, a);
      expect(await verifiedAt(lineup)).toBeNull();

      await master(lineup, b);
      expect(await verifiedAt(lineup)).toBeNull();

      await master(lineup, c);
      expect(await verifiedAt(lineup)).not.toBeNull();
    });

    // mastered_at is writable by a player on their own progress row, so a count
    // of rows rather than of people would let one account verify anything.
    it("counts players, not masteries", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const only = await fx.player();

      await master(lineup, only);

      for (let attempt = 0; attempt < 5; attempt++) {
        await postgres.query(
          `UPDATE nade_lineup_progress
              SET mastered_at = now(), attempts = attempts + 1
            WHERE nade_lineup_id = $1::uuid AND steam_id = $2::bigint`,
          [lineup, only],
        );
      }

      expect(await verifiedAt(lineup)).toBeNull();
    });

    it("reads the bar out of the setting", async () => {
      await setting("public.nade_verify_masteries", "2");

      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b] = await fx.players(2);

      await master(lineup, a);
      expect(await verifiedAt(lineup)).toBeNull();

      await master(lineup, b);
      expect(await verifiedAt(lineup)).not.toBeNull();
    });

    // The trigger sits on the highest-frequency write in the library. A setting
    // somebody typed a word into must not take every practice throw down with it.
    it("falls back rather than failing the write on a nonsense setting", async () => {
      await setting("public.nade_verify_masteries", "soon");

      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b, c] = await fx.players(3);

      await expect(master(lineup, a)).resolves.toBeUndefined();
      await master(lineup, b);
      expect(await verifiedAt(lineup)).toBeNull();

      await master(lineup, c);
      expect(await verifiedAt(lineup)).not.toBeNull();
    });

    it("only counts players who actually mastered it", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b, c] = await fx.players(3);

      await master(lineup, a);
      await master(lineup, b);

      await postgres.query(
        `INSERT INTO nade_lineup_progress
           (nade_lineup_id, steam_id, attempts, successes, current_streak)
         VALUES ($1::uuid, $2::bigint, 40, 3, 0)`,
        [lineup, c],
      );

      expect(await verifiedAt(lineup)).toBeNull();
    });

    it("verifies each lineup off its own masters", async () => {
      const author = await fx.player();
      const one = await insertLineup(author);
      const two = await insertLineup(author, { land_x: LAND.x + 900 });
      const [a, b, c] = await fx.players(3);

      await master(one, a);
      await master(one, b);
      await master(two, c);

      expect(await verifiedAt(one)).toBeNull();
      expect(await verifiedAt(two)).toBeNull();

      await master(one, c);

      expect(await verifiedAt(one)).not.toBeNull();
      expect(await verifiedAt(two)).toBeNull();
    });
  });

  describe("what it must never do", () => {
    // Verification is a claim about the lineup, not about anybody's current
    // form. A missed throw next week is not evidence the smoke stopped working.
    it("never un-verifies on a later miss", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b, c] = await fx.players(3);

      await master(lineup, a);
      await master(lineup, b);
      await master(lineup, c);

      const verified = await verifiedAt(lineup);
      expect(verified).not.toBeNull();

      await postgres.query(
        `UPDATE nade_lineup_progress
            SET current_streak = 0, attempts = attempts + 1
          WHERE nade_lineup_id = $1::uuid`,
        [lineup],
      );

      expect(await verifiedAt(lineup)).toEqual(verified);
    });

    it("leaves a moderator's own verification exactly where it was", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author, {
        verified_at: "2020-01-02T03:04:05.000Z",
      });
      const [a, b, c] = await fx.players(3);

      await master(lineup, a);
      await master(lineup, b);
      await master(lineup, c);

      expect((await verifiedAt(lineup))?.toISOString()).toBe(
        "2020-01-02T03:04:05.000Z",
      );
    });

    it("does not restamp a lineup that is already verified", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b, c, d] = await fx.players(4);

      await master(lineup, a);
      await master(lineup, b);
      await master(lineup, c);

      const verified = await verifiedAt(lineup);

      await master(lineup, d);

      expect(await verifiedAt(lineup)).toEqual(verified);
    });
  });

  // The end-to-end shape: nobody writes mastered_at by hand in production, the
  // scoring path does, and the scoring path recomputes the distance itself.
  describe("through the real scoring path", () => {
    async function drill(
      lineups: NadeLineupsService,
      context: NadeServerContext,
      lineupId: string,
      steamId: string,
    ) {
      for (let throwOf = 0; throwOf < 5; throwOf++) {
        await lineups.recordPracticeResult(context, {
          nade_lineup_id: lineupId,
          steam_id: steamId,
          land_x: LAND.x,
          land_y: LAND.y,
          land_z: LAND.z,
        });
      }
    }

    it("verifies a lineup three players have drilled", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);
      const lineups = makeService();
      const context: NadeServerContext = {
        serverId: "00000000-0000-4000-8000-000000000000",
        matchId: "00000000-0000-4000-8000-000000000001",
        mapName: "de_mirage",
        lineupSteamIds: players,
      };

      await drill(lineups, context, lineup, players[0]);
      await drill(lineups, context, lineup, players[1]);
      expect(await verifiedAt(lineup)).toBeNull();

      await drill(lineups, context, lineup, players[2]);
      expect(await verifiedAt(lineup)).not.toBeNull();
    });

    it("ignores throws that were nowhere near it", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);
      const lineups = makeService();
      const context: NadeServerContext = {
        serverId: "00000000-0000-4000-8000-000000000000",
        matchId: "00000000-0000-4000-8000-000000000001",
        mapName: "de_mirage",
        lineupSteamIds: players,
      };

      await drill(lineups, context, lineup, players[0]);
      await drill(lineups, context, lineup, players[1]);

      for (let throwOf = 0; throwOf < 5; throwOf++) {
        await lineups.recordPracticeResult(context, {
          nade_lineup_id: lineup,
          steam_id: players[2],
          land_x: LAND.x + 400,
          land_y: LAND.y,
          land_z: LAND.z,
          success: true,
        });
      }

      expect(await verifiedAt(lineup)).toBeNull();
    });
  });
});
