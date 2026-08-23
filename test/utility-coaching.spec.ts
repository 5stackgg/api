import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityInsightsService } from "./../src/utility/utility-insights.service";
import {
  UtilityLineupsService,
  UtilityServerContext,
} from "./../src/utility/utility-lineups.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";
import { UtilityPendingLineup } from "./../src/utility/utility-load.service";

// The two things the practice data can say that a browse cannot: which way
// everybody misses one lineup, and how hard the lineup is for everybody.
//
// Both are read as aggregates and both have one property worth more than their
// arithmetic. The pattern must be the lineup's and not one obsessive's, and the
// difficulty must refuse to answer rather than invent a rate off four throws.
describe("utility coaching (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let insights: UtilityInsightsService;

  // Everything below is thrown due north (+Y): the lineup stands at the world
  // origin looking along yaw 90 and lands a thousand units up the map. It makes
  // every assertion readable -- a landing short of the reference is a smaller
  // y, and it is the geometry that catches an along/lateral mix-up, because a
  // decomposition that used the world axes would call an undershoot "left".
  const ORIGIN = { x: 0, y: 0, z: 0 };
  const LAND = { x: 0, y: 1000, z: 0 };
  const NORTH_YAW = 90;

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityCoachingTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199620000000n);
    insights = new UtilityInsightsService(postgres, lineupsService());
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_meta_lineups");
    await postgres.query("DELETE FROM utility_lineup_progress");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM players");
    await postgres.query(
      "UPDATE settings SET value = '96' WHERE name = 'public.utility_success_radius'",
    );
  });

  function lineupsService(): UtilityLineupsService {
    const store = new Map<string, unknown>();

    return new UtilityLineupsService(
      new Logger("UtilityCoachingTest"),
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
      {
        pending: jest.fn(async (): Promise<Array<UtilityPendingLineup>> => []),
      } as unknown as never,
    );
  }

  const user = (steamId: string): User =>
    ({ steam_id: steamId, role: "user", name: "tester" }) as User;

  function context(...steamIds: Array<string>): UtilityServerContext {
    return {
      serverId: randomUUID(),
      matchId: randomUUID(),
      mapName: "de_mirage",
      lineupSteamIds: steamIds,
    };
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
      origin_x: ORIGIN.x,
      origin_y: ORIGIN.y,
      origin_z: ORIGIN.z,
      view_yaw: NORTH_YAW,
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
      `INSERT INTO utility_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  // A player's accumulated offsets, written the way the scoring path would have
  // left them: sums over `samples` throws whose mean is the offset given.
  async function drilled(
    lineupId: string,
    steamId: string,
    offsets: {
      samples: number;
      along?: number;
      lateral?: number;
      vertical?: number;
      successes?: number;
    },
  ): Promise<void> {
    await postgres.query(
      `INSERT INTO utility_lineup_progress
         (utility_lineup_id, steam_id, attempts, successes,
          miss_samples, miss_along_sum, miss_lateral_sum, miss_vertical_sum)
       VALUES ($1::uuid, $2::bigint, $3::int, $4::int,
               $3::int, $5::float8, $6::float8, $7::float8)`,
      [
        lineupId,
        steamId,
        offsets.samples,
        offsets.successes ?? 0,
        (offsets.along ?? 0) * offsets.samples,
        (offsets.lateral ?? 0) * offsets.samples,
        (offsets.vertical ?? 0) * offsets.samples,
      ],
    );
  }

  async function counters(lineupId: string) {
    const [row] = await postgres.query<
      Array<{
        practice_players: number;
        practice_attempts: number;
        practice_successes: number;
        difficulty: string;
      }>
    >(
      `SELECT l.practice_players, l.practice_attempts, l.practice_successes,
              public.utility_lineup_difficulty(l) AS difficulty
         FROM utility_lineups l WHERE l.id = $1::uuid`,
      [lineupId],
    );
    return row;
  }

  describe("decomposing a throw", () => {
    // The test that catches the whole idea being wrong. A throw aimed due north
    // that lands short is short; a decomposition on the world axes would report
    // it as a thousand units of nothing on x and call the error lateral.
    it("reads an undershoot on a due-north throw as short, not left", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const lineups = lineupsService();

      const result = await lineups.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x,
        land_y: LAND.y - 100,
        land_z: LAND.z,
      });

      expect(result.along).toBe(-100);
      expect(result.lateral).toBe(0);
      expect(result.vertical).toBe(0);
      expect(result.success).toBe(false);
      expect(result.distance).toBe(100);
    });

    it("reads an overshoot as long", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const lineups = lineupsService();

      const result = await lineups.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x,
        land_y: LAND.y + 250,
        land_z: LAND.z,
      });

      expect(result.along).toBe(250);
      expect(result.lateral).toBe(0);
    });

    // Facing +Y, the player's right hand points at +X. Getting this backwards
    // would tell everybody on the platform to correct the wrong way.
    it("puts the thrower's right hand on the positive lateral axis", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const lineups = lineupsService();

      const right = await lineups.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x + 150,
        land_y: LAND.y,
        land_z: LAND.z,
      });

      expect(right.lateral).toBe(150);
      expect(right.along).toBe(0);

      const left = await lineups.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x - 150,
        land_y: LAND.y,
        land_z: LAND.z,
      });

      expect(left.lateral).toBe(-150);
    });

    it("keeps height on its own axis", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const lineups = lineupsService();

      const result = await lineups.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x,
        land_y: LAND.y,
        land_z: LAND.z + 140,
      });

      expect(result.vertical).toBe(140);
      expect(result.along).toBe(0);
      expect(result.lateral).toBe(0);
    });

    // A hand-placed or imported lineup can carry a view_yaw with no relation to
    // its own landing point. Believing it does not fail loudly: it reports every
    // undershoot as an overshoot.
    it("falls back to the origin-to-landing bearing when the recorded aim points the other way", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player, {
        view_yaw: NORTH_YAW + 180,
        origin_source: "editor",
      });
      const lineups = lineupsService();

      const result = await lineups.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x,
        land_y: LAND.y - 100,
        land_z: LAND.z,
      });

      expect(result.along).toBe(-100);
    });

    it("keeps the recorded aim when it agrees with where the grenade went", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player, { view_yaw: NORTH_YAW + 20 });
      const lineups = lineupsService();

      const result = await lineups.recordPracticeResult(context(player), {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x,
        land_y: LAND.y - 100,
        land_z: LAND.z,
      });

      // Aiming 20 degrees left of where the grenade actually travelled, so the
      // undershoot splits across both axes of the aim frame rather than reading
      // as a pure one: coming back down a line that runs to the right of your
      // aim is both short of it and left of it.
      expect(result.along).toBeCloseTo(
        -100 * Math.cos((20 * Math.PI) / 180),
        1,
      );
      expect(result.lateral).toBeCloseTo(
        -100 * Math.sin((20 * Math.PI) / 180),
        1,
      );
    });

    it("accumulates the offsets on the throwing player's own row", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const lineups = lineupsService();

      for (let attempt = 0; attempt < 3; attempt++) {
        await lineups.recordPracticeResult(context(player), {
          utility_lineup_id: lineup,
          steam_id: player,
          land_x: LAND.x,
          land_y: LAND.y - 100,
          land_z: LAND.z,
        });
      }

      const [row] = await postgres.query<
        Array<{ miss_samples: number; miss_along_sum: number }>
      >(
        `SELECT miss_samples, miss_along_sum FROM utility_lineup_progress
          WHERE utility_lineup_id = $1::uuid AND steam_id = $2::bigint`,
        [lineup, player],
      );

      expect(row.miss_samples).toBe(3);
      expect(row.miss_along_sum).toBeCloseTo(-300, 6);
    });
  });

  describe("the miss pattern", () => {
    it("says nothing rather than coaching off one player", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b] = await fx.players(2);

      await drilled(lineup, a, { samples: 40, along: -200 });
      await drilled(lineup, b, { samples: 40, along: -200 });

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.analysed).toBe(false);
      expect(pattern.players).toBe(2);
      expect(pattern.samples).toBe(80);
      expect(pattern.bias).toBeNull();
      expect(pattern.mean_along).toBeNull();
      expect(pattern.message).toMatch(/not enough practice/);
    });

    it("says nothing rather than coaching off a handful of throws", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(lineup, player, { samples: 5, along: -200 });
      }

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.analysed).toBe(false);
      expect(pattern.players).toBe(3);
      expect(pattern.samples).toBe(15);
    });

    it("calls a shared undershoot short once both floors clear", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(lineup, player, { samples: 7, along: -140 });
      }

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.analysed).toBe(true);
      expect(pattern.players).toBe(3);
      expect(pattern.samples).toBe(21);
      expect(pattern.mean_along).toBe(-140);
      expect(pattern.bias).toBe(UtilityInsightsService.BIAS_SHORT);
    });

    // The whole reason the sums live per player rather than per lineup. Under a
    // mean of throws this lineup reads 275 long, which is one person's habit
    // handed to everybody else as the lineup's pattern.
    it("counts a player who threw two hundred times exactly once", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [obsessive, a, b] = await fx.players(3);

      await drilled(lineup, obsessive, { samples: 200, along: 300 });
      await drilled(lineup, a, { samples: 10, along: 30 });
      await drilled(lineup, b, { samples: 10, along: 30 });

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.samples).toBe(220);
      expect(pattern.players).toBe(3);
      expect(pattern.mean_along).toBe(120);
      expect(pattern.bias).toBe(UtilityInsightsService.BIAS_LONG);
    });

    it("reports the axis the miss is worst on", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(lineup, player, {
          samples: 10,
          along: -30,
          lateral: 120,
          vertical: 10,
        });
      }

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.mean_along).toBe(-30);
      expect(pattern.mean_lateral).toBe(120);
      expect(pattern.mean_vertical).toBe(10);
      expect(pattern.bias).toBe(UtilityInsightsService.BIAS_RIGHT);
    });

    it("reads a high miss as high", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(lineup, player, { samples: 10, vertical: 90 });
      }

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.bias).toBe(UtilityInsightsService.BIAS_HIGH);
    });

    it("says there is no pattern when everybody lands on it", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b, c] = await fx.players(3);

      await drilled(lineup, a, { samples: 10, along: 5 });
      await drilled(lineup, b, { samples: 10, along: -5 });
      await drilled(lineup, c, { samples: 10, along: 0 });

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.analysed).toBe(true);
      expect(pattern.bias).toBe(UtilityInsightsService.BIAS_NONE);
    });

    // The mean of a group that disagrees is a number nobody in it would
    // recognise, and "you undershoot this" is the wrong thing to tell the half
    // of them who overshoot it.
    it("refuses to name a direction the players do not agree on", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b, c] = await fx.players(3);

      await drilled(lineup, a, { samples: 10, along: 300 });
      await drilled(lineup, b, { samples: 10, along: -100 });
      await drilled(lineup, c, { samples: 10, along: -50 });

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.mean_along).toBe(50);
      expect(pattern.bias).toBe(UtilityInsightsService.BIAS_SCATTERED);
    });

    it("scales the floor with the configured success radius", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(lineup, player, { samples: 10, along: -30 });
      }

      expect(
        (await insights.missPattern(user(author), { utility_lineup_id: lineup }))
          .bias,
      ).toBe(UtilityInsightsService.BIAS_SHORT);

      await postgres.query(
        "UPDATE settings SET value = '400' WHERE name = 'public.utility_success_radius'",
      );

      expect(
        (await insights.missPattern(user(author), { utility_lineup_id: lineup }))
          .bias,
      ).toBe(UtilityInsightsService.BIAS_NONE);
    });

    it("will not read a pattern off a lineup the caller cannot see", async () => {
      const stranger = await fx.player();
      const nosy = await fx.player();
      const secret = await insertLineup(stranger, { visibility: "Private" });
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(secret, player, { samples: 10, along: -200 });
      }

      await expect(
        insights.missPattern(user(nosy), { utility_lineup_id: secret }),
      ).rejects.toThrow(/lineup not found/);

      const owner = await insights.missPattern(user(stranger), {
        utility_lineup_id: secret,
      });
      expect(owner.analysed).toBe(true);
    });

    // A hit is not a miss, but it carries a direction and the direction is the
    // point. Dropping hits would truncate the sample at the success radius, so
    // a lineup the whole platform lands 60 units short of -- most of a smoke's
    // width, and a real release-angle correction -- would come back saying
    // nothing at all.
    it("builds the pattern out of throws that landed as well as ones that did not", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);
      const lineups = lineupsService();
      const ctx = context(...players);

      for (const player of players) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const result = await lineups.recordPracticeResult(ctx, {
            utility_lineup_id: lineup,
            steam_id: player,
            land_x: LAND.x,
            land_y: LAND.y - 60,
            land_z: LAND.z,
          });
          expect(result.success).toBe(true);
        }
      }

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.analysed).toBe(true);
      expect(pattern.samples).toBe(30);
      expect(pattern.mean_along).toBe(-60);
      expect(pattern.bias).toBe(UtilityInsightsService.BIAS_SHORT);

      // Thirty throws that all counted, so the same throws that built the
      // pattern also mastered the lineup for all three of them.
      const [verified] = await postgres.query<
        Array<{ verified_at: Date | null }>
      >("SELECT verified_at FROM utility_lineups WHERE id = $1::uuid", [lineup]);
      expect(verified.verified_at).not.toBeNull();
    });

    // The sums are vectors measured against one target point. Move the target
    // and every one of them describes a lineup that no longer exists.
    it("forgets the offsets when the lineup's geometry is edited", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(lineup, player, {
          samples: 10,
          along: -140,
          successes: 4,
        });
      }

      await postgres.query(
        "UPDATE utility_lineups SET land_x = land_x + 300 WHERE id = $1::uuid",
        [lineup],
      );

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.analysed).toBe(false);
      expect(pattern.samples).toBe(0);
      expect(pattern.players).toBe(0);

      // The record that people practised survives the edit; only the vectors
      // measured against the old target are dropped.
      const row = await counters(lineup);
      expect(row.practice_attempts).toBe(30);
      expect(row.practice_successes).toBe(12);
    });

    it("leaves the offsets alone when the lineup is renamed", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(lineup, player, { samples: 10, along: -140 });
      }

      await postgres.query(
        "UPDATE utility_lineups SET name = 'renamed' WHERE id = $1::uuid",
        [lineup],
      );

      const pattern = await insights.missPattern(user(author), {
        utility_lineup_id: lineup,
      });

      expect(pattern.analysed).toBe(true);
      expect(pattern.samples).toBe(30);
    });
  });

  describe("difficulty counters", () => {
    it("counts every player's practice onto the lineup", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      for (const player of players) {
        await drilled(lineup, player, { samples: 10, successes: 8 });
      }

      const row = await counters(lineup);
      expect(row.practice_players).toBe(3);
      expect(row.practice_attempts).toBe(30);
      expect(row.practice_successes).toBe(24);
    });

    it("moves on every attempt and not only on the one that masters it", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);
      const lineups = lineupsService();
      const ctx = context(player);

      await lineups.recordPracticeResult(ctx, {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x,
        land_y: LAND.y - 900,
        land_z: LAND.z,
      });

      const afterMiss = await counters(lineup);
      expect(afterMiss.practice_players).toBe(1);
      expect(afterMiss.practice_attempts).toBe(1);
      expect(afterMiss.practice_successes).toBe(0);

      await lineups.recordPracticeResult(ctx, {
        utility_lineup_id: lineup,
        steam_id: player,
        land_x: LAND.x,
        land_y: LAND.y,
        land_z: LAND.z,
      });

      const afterHit = await counters(lineup);
      expect(afterHit.practice_attempts).toBe(2);
      expect(afterHit.practice_successes).toBe(1);
    });

    it("does not count a player who has opened a lineup but never thrown at it", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const looker = await fx.player();

      await postgres.query(
        `INSERT INTO utility_lineup_progress (utility_lineup_id, steam_id)
         VALUES ($1::uuid, $2::bigint)`,
        [lineup, looker],
      );

      const opened = await counters(lineup);
      expect(opened.practice_players).toBe(0);

      await postgres.query(
        `UPDATE utility_lineup_progress SET attempts = 4, successes = 1
          WHERE utility_lineup_id = $1::uuid AND steam_id = $2::bigint`,
        [lineup, looker],
      );

      const thrown = await counters(lineup);
      expect(thrown.practice_players).toBe(1);
      expect(thrown.practice_attempts).toBe(4);
      expect(thrown.practice_successes).toBe(1);
    });

    it("gives the counters back when a player's progress goes away", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const [a, b] = await fx.players(2);

      await drilled(lineup, a, { samples: 10, successes: 6 });
      await drilled(lineup, b, { samples: 10, successes: 4 });

      await postgres.query(
        "DELETE FROM utility_lineup_progress WHERE utility_lineup_id = $1::uuid AND steam_id = $2::bigint",
        [lineup, a],
      );

      const row = await counters(lineup);
      expect(row.practice_players).toBe(1);
      expect(row.practice_attempts).toBe(10);
      expect(row.practice_successes).toBe(4);
    });
  });

  describe("difficulty", () => {
    async function drilledBy(
      lineupId: string,
      players: Array<string>,
      attempts: number,
      successes: number,
    ): Promise<void> {
      for (const player of players) {
        await drilled(lineupId, player, {
          samples: attempts,
          successes,
        });
      }
    }

    // difficulty is mounted as a computed field on utility_lineups and the web
    // app selects it in the fragment behind every utility screen, so the shape
    // Hasura needs is load-bearing far past this feature: it refuses to mount
    // a VOLATILE function, and a session argument it was not told about would
    // make it a two-argument function it cannot call.
    it("keeps the difficulty function in the shape a computed field needs", async () => {
      const [fn] = await postgres.query<
        Array<{ volatility: string; args: number; result: string }>
      >(
        `SELECT p.provolatile AS volatility,
                p.pronargs::int AS args,
                pg_get_function_result(p.oid) AS result
           FROM pg_proc p
          WHERE p.proname = 'utility_lineup_difficulty'
            AND p.pronamespace = 'public'::regnamespace
            AND p.proargtypes[0] = 'public.utility_lineups'::regtype`,
      );

      expect(fn).toBeDefined();
      expect(fn.volatility).toBe("s");
      expect(fn.args).toBe(1);
      expect(fn.result).toBe("text");
    });

    // The statistical trap. Four attempts by one player is not a hard lineup,
    // and neither is a rate computed off it -- the UI renders a token, and
    // every token except this one is a claim.
    it("refuses to call a lineup anything off one player's afternoon", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const only = await fx.player();

      await drilled(lineup, only, { samples: 40, successes: 2 });

      const row = await counters(lineup);
      expect(row.practice_attempts).toBe(40);
      expect(row.difficulty).toBe(UtilityInsightsService.UNMEASURED);
    });

    it("refuses to call a lineup anything off a handful of attempts", async () => {
      const author = await fx.player();
      const lineup = await insertLineup(author);
      const players = await fx.players(3);

      await drilledBy(lineup, players, 4, 1);

      expect((await counters(lineup)).difficulty).toBe(
        UtilityInsightsService.UNMEASURED,
      );
    });

    it("grades a measured lineup on what everybody lands", async () => {
      const author = await fx.player();
      const easy = await insertLineup(author, { name: "easy" });
      const moderate = await insertLineup(author, {
        name: "moderate",
        land_x: LAND.x + 700,
      });
      const hard = await insertLineup(author, {
        name: "hard",
        land_x: LAND.x + 1400,
      });
      const veryHard = await insertLineup(author, {
        name: "very hard",
        land_x: LAND.x + 2100,
      });
      const players = await fx.players(3);

      await drilledBy(easy, players, 10, 8);
      await drilledBy(moderate, players, 10, 5);
      await drilledBy(hard, players, 10, 3);
      await drilledBy(veryHard, players, 10, 1);

      expect((await counters(easy)).difficulty).toBe(UtilityInsightsService.EASY);
      expect((await counters(moderate)).difficulty).toBe(
        UtilityInsightsService.MODERATE,
      );
      expect((await counters(hard)).difficulty).toBe(UtilityInsightsService.HARD);
      expect((await counters(veryHard)).difficulty).toBe(
        UtilityInsightsService.VERY_HARD,
      );
    });
  });

  describe("difficulty in the practice plan", () => {
    // The cluster the miner would have written for a lineup's bucket, read back
    // off the lineup so the two can never disagree about the key.
    async function metaFor(lineupId: string, throwers: number): Promise<void> {
      await postgres.query(
        `INSERT INTO utility_meta_lineups
           (lineup_bucket, map_name, utility_type, side, technique,
            throws, throwers, matches, lineups,
            origin_x, origin_y, origin_z, land_x, land_y, land_z)
         SELECT l.lineup_bucket, l.map_name, l.utility_type, l.side, l.technique,
                $2::int * 3, $2::int, $2::int, 1,
                l.origin_x, l.origin_y, l.origin_z, l.land_x, l.land_y, l.land_z
           FROM utility_lineups l
          WHERE l.id = $1::uuid
         ON CONFLICT (lineup_bucket) DO UPDATE SET throwers = EXCLUDED.throwers`,
        [lineupId, throwers],
      );
    }

    async function plannedMap(): Promise<{
      caller: string;
      easy: string;
      veryHard: string;
      unknown: string;
    }> {
      const author = await fx.player();
      const caller = await fx.player();
      const drillers = await fx.players(3);

      const easy = await insertLineup(author, { name: "easy" });
      const veryHard = await insertLineup(author, {
        name: "very hard",
        land_x: LAND.x + 700,
      });
      const unknown = await insertLineup(author, {
        name: "unknown",
        land_x: LAND.x + 1400,
      });

      await metaFor(easy, 10);
      await metaFor(veryHard, 20);
      await metaFor(unknown, 30);

      for (const driller of drillers) {
        await drilled(easy, driller, { samples: 10, successes: 8 });
        await drilled(veryHard, driller, { samples: 10, successes: 1 });
      }
      await drilled(unknown, drillers[0], { samples: 4, successes: 1 });

      return { caller, easy, veryHard, unknown };
    }

    it("carries the difficulty and the platform's landing rate on every entry", async () => {
      const { caller, easy, unknown } = await plannedMap();

      const plan = await insights.practicePlan(user(caller), {
        map_name: "de_mirage",
      });

      const byId = new Map(
        plan.entries.map((entry) => [entry.utility_lineup_id, entry]),
      );

      expect(byId.get(easy)?.difficulty).toBe(UtilityInsightsService.EASY);
      expect(byId.get(easy)?.global_players).toBe(3);
      expect(byId.get(easy)?.global_attempts).toBe(30);
      expect(byId.get(easy)?.global_landing_rate).toBeCloseTo(0.8, 3);

      // Unmeasured means unmeasured: there is a count, and deliberately no rate
      // for the UI to render as if it were knowledge.
      expect(byId.get(unknown)?.difficulty).toBe(
        UtilityInsightsService.UNMEASURED,
      );
      expect(byId.get(unknown)?.global_attempts).toBe(4);
      expect(byId.get(unknown)?.global_landing_rate).toBeNull();
    });

    it("leaves the existing ranking exactly where it was", async () => {
      const { caller, easy, veryHard, unknown } = await plannedMap();

      const plan = await insights.practicePlan(user(caller), {
        map_name: "de_mirage",
      });

      expect(plan.entries.map((entry) => entry.utility_lineup_id)).toEqual([
        unknown,
        veryHard,
        easy,
      ]);
    });

    it("puts the five-minute learns first when asked for quick wins", async () => {
      const { caller, easy, veryHard, unknown } = await plannedMap();

      const plan = await insights.practicePlan(user(caller), {
        map_name: "de_mirage",
        order: UtilityInsightsService.ORDER_QUICK_WINS,
      });

      expect(plan.entries.map((entry) => entry.utility_lineup_id)).toEqual([
        easy,
        veryHard,
        unknown,
      ]);
    });

    it("puts the week's work first when asked for projects", async () => {
      const { caller, easy, veryHard, unknown } = await plannedMap();

      const plan = await insights.practicePlan(user(caller), {
        map_name: "de_mirage",
        order: UtilityInsightsService.ORDER_PROJECTS,
      });

      // The unmeasured one has the highest priority on the map and still sorts
      // behind both measured ones: it is not known to be hard, it is unknown.
      expect(plan.entries.map((entry) => entry.utility_lineup_id)).toEqual([
        veryHard,
        easy,
        unknown,
      ]);
    });

    it("refuses an order it does not know rather than silently ranking by something else", async () => {
      const { caller } = await plannedMap();

      await expect(
        insights.practicePlan(user(caller), {
          map_name: "de_mirage",
          order: "easiest",
        }),
      ).rejects.toThrow(/unknown order/);
    });
  });
});
