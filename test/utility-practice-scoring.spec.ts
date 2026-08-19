import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import {
  UtilityLineupsService,
  UtilityServerContext,
} from "./../src/utility/utility-lineups.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// Scoring is the one place a game server's word would move a player's record,
// so none of it is taken on trust: the distance is recomputed here from the
// stored lineup, and the plugin's own verdict changes nothing.
describe("utility practice scoring (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  const TARGET = { x: -560, y: 320, z: -140 };

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityScoringTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199910000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_lineup_progress");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "DELETE FROM settings WHERE name LIKE 'public.utility_%'",
    );
  });

  function makeService(): UtilityLineupsService {
    const store = new Map<string, unknown>();

    return new UtilityLineupsService(
      new Logger("UtilityScoringTest"),
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
      utility_type: "Smoke",
      side: "TERRORIST",
      technique: "Jump",
      origin_x: -1912,
      origin_y: 922,
      origin_z: -167,
      view_yaw: 133.7,
      view_pitch: -12.4,
      land_x: TARGET.x,
      land_y: TARGET.y,
      land_z: TARGET.z,
      name: "Window from T spawn",
      visibility: "Private",
      author_steam_id: author,
      ...overrides,
    };
    const cols = Object.keys(row);
    const [inserted] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO utility_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row) as Array<string>,
    );
    return inserted.id;
  }

  function context(...steamIds: Array<string>): UtilityServerContext {
    return {
      serverId: randomUUID(),
      matchId: randomUUID(),
      mapName: "de_mirage",
      lineupSteamIds: steamIds,
    };
  }

  async function progress(lineupId: string, steamId: string) {
    const [row] = await postgres.query<
      Array<{
        attempts: number;
        successes: number;
        current_streak: number;
        best_streak: number;
        last_practiced_at: Date | null;
        mastered_at: Date | null;
      }>
    >(
      `SELECT attempts, successes, current_streak, best_streak,
              last_practiced_at, mastered_at
         FROM utility_lineup_progress
        WHERE utility_lineup_id = $1::uuid AND steam_id = $2::bigint`,
      [lineupId, steamId],
    );
    return row;
  }

  describe("scoring a throw", () => {
    it("counts a throw that lands on the lineup", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const service = makeService();

      const result = await service.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: TARGET.x,
        land_y: TARGET.y,
        land_z: TARGET.z,
      });

      expect(result.success).toBe(true);
      expect(result.distance).toBe(0);
      expect(result.attempts).toBe(1);
      expect(result.successes).toBe(1);
      expect(result.current_streak).toBe(1);

      const row = await progress(lineup, player);
      expect(row.attempts).toBe(1);
      expect(row.successes).toBe(1);
      expect(row.last_practiced_at).not.toBeNull();
      expect(row.mastered_at).toBeNull();
    });

    // The whole point of the endpoint: a compromised plugin can report a throw
    // that did not happen, but not a throw that did not land.
    it("recomputes the distance instead of believing the plugin", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const service = makeService();

      const result = await service.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: TARGET.x + 900,
        land_y: TARGET.y,
        land_z: TARGET.z,
        success: true,
      });

      expect(result.success).toBe(false);
      expect(result.distance).toBe(900);
      expect(result.successes).toBe(0);

      const row = await progress(lineup, player);
      expect(row.attempts).toBe(1);
      expect(row.successes).toBe(0);
      expect(row.current_streak).toBe(0);
    });

    it("counts a throw inside the radius", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const service = makeService();

      const result = await service.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: TARGET.x + 50,
        land_y: TARGET.y,
        land_z: TARGET.z,
      });

      expect(result.success).toBe(true);
      expect(result.radius).toBe(UtilityLineupsService.DEFAULT_SUCCESS_RADIUS);
    });

    it("scores against the configured radius, not a constant", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      await setting("public.utility_success_radius", "10");
      const service = makeService();

      const result = await service.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: TARGET.x + 50,
        land_y: TARGET.y,
        land_z: TARGET.z,
      });

      expect(result.radius).toBe(10);
      expect(result.success).toBe(false);
    });
  });

  describe("mastery", () => {
    async function throwAt(
      service: UtilityLineupsService,
      ctx: UtilityServerContext,
      lineup: string,
      player: string,
      offset: number,
    ) {
      return await service.recordPracticeResult(ctx, {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: TARGET.x + offset,
        land_y: TARGET.y,
        land_z: TARGET.z,
      });
    }

    it("masters a lineup on the consecutive-success bar and keeps it after a miss", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const service = makeService();
      const ctx = context(player);

      for (let i = 1; i < UtilityLineupsService.MASTERY_STREAK; i++) {
        const result = await throwAt(service, ctx, lineup, player, 0);
        expect(result.current_streak).toBe(i);
        expect(result.mastered_at).toBeNull();
      }

      const mastering = await throwAt(service, ctx, lineup, player, 0);
      expect(mastering.current_streak).toBe(UtilityLineupsService.MASTERY_STREAK);
      expect(mastering.mastered_at).not.toBeNull();

      const missed = await throwAt(service, ctx, lineup, player, 900);
      expect(missed.current_streak).toBe(0);
      expect(missed.best_streak).toBe(UtilityLineupsService.MASTERY_STREAK);
      expect(missed.mastered_at).toEqual(mastering.mastered_at);
      expect(missed.attempts).toBe(UtilityLineupsService.MASTERY_STREAK + 1);
      expect(missed.successes).toBe(UtilityLineupsService.MASTERY_STREAK);
    });

    it("does not master a lineup hit the same number of times but not in a row", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const service = makeService();
      const ctx = context(player);

      for (let i = 0; i < UtilityLineupsService.MASTERY_STREAK; i++) {
        await throwAt(service, ctx, lineup, player, 0);
        await throwAt(service, ctx, lineup, player, 900);
      }

      const row = await progress(lineup, player);
      expect(row.successes).toBe(UtilityLineupsService.MASTERY_STREAK);
      expect(row.best_streak).toBe(1);
      expect(row.mastered_at).toBeNull();
    });
  });

  describe("what a server may report", () => {
    it("refuses a player who is not on this server", async () => {
      const player = await fx.player();
      const stranger = await fx.player();
      const lineup = await insertLineup(player);
      const service = makeService();

      await expect(
        service.recordPracticeResult(context(player), {
          utility_lineup_id: lineup,
          steam_id: stranger,
          land_x: TARGET.x,
          land_y: TARGET.y,
          land_z: TARGET.z,
        }),
      ).rejects.toThrow(/not in this match lineup/);
    });

    it("refuses a lineup the player cannot see", async () => {
      const player = await fx.player();
      const stranger = await fx.player();
      const secret = await insertLineup(stranger);
      const service = makeService();

      await expect(
        service.recordPracticeResult(context(player), {
          utility_lineup_id: secret,
          steam_id: player,
          land_x: TARGET.x,
          land_y: TARGET.y,
          land_z: TARGET.z,
        }),
      ).rejects.toThrow(/lineup not found/);
    });

    it("refuses a lineup that is not on the map the server is running", async () => {
      const player = await fx.player();
      const elsewhere = await insertLineup(player, { map_name: "de_nuke" });
      const service = makeService();

      await expect(
        service.recordPracticeResult(context(player), {
          utility_lineup_id: elsewhere,
          steam_id: player,
          land_x: TARGET.x,
          land_y: TARGET.y,
          land_z: TARGET.z,
        }),
      ).rejects.toThrow(/not on this map/);
    });

    it("refuses a detonation outside the map", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const service = makeService();

      await expect(
        service.recordPracticeResult(context(player), {
          utility_lineup_id: lineup,
          steam_id: player,
          land_x: 999999,
          land_y: TARGET.y,
          land_z: TARGET.z,
        }),
      ).rejects.toThrow(/outside the map/);
    });

    it("refuses a result with no lineup", async () => {
      const player = await fx.player();
      const service = makeService();

      await expect(
        service.recordPracticeResult(context(player), {
          utility_lineup_id: "not-a-lineup",
          steam_id: player,
          land_x: TARGET.x,
          land_y: TARGET.y,
          land_z: TARGET.z,
        }),
      ).rejects.toThrow(/not a lineup/);
    });
  });

  describe("rate limiting", () => {
    it("cuts off one player on one server without touching anybody else", async () => {
      const player = await fx.player();
      const mate = await fx.player();
      const lineup = await insertLineup(player, { visibility: "Public" });
      const service = makeService();
      const ctx = context(player, mate);

      const attempt = (steamId: string) =>
        service.recordPracticeResult(ctx, {
          utility_lineup_id: lineup,
          steam_id: steamId,
          land_x: TARGET.x,
          land_y: TARGET.y,
          land_z: TARGET.z,
        });

      for (let i = 0; i < UtilityLineupsService.RESULTS_PER_MINUTE; i++) {
        await attempt(player);
      }

      await expect(attempt(player)).rejects.toThrow(/too quickly/);
      await expect(attempt(mate)).resolves.toBeTruthy();
    });
  });
});
