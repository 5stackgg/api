import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { UtilityInsightsService } from "./../src/utility/utility-insights.service";
import { UtilityLineupsService } from "./../src/utility/utility-lineups.service";
import { User } from "./../src/auth/types/User";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";
import { UtilityPendingLineup } from "./../src/utility/utility-load.service";
import { UtilityCalloutsService } from "./../src/utility/utility-callouts.service";

// The two reads over mined data. Both have one property that is worth more than
// their arithmetic: the plan must not answer "nothing to learn" when the truth
// is "nothing has been mined", and the team report must never hand back a row
// out of utility_demo_throws, which names players and is admin-only for that
// reason.
describe("utility insights (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let insights: UtilityInsightsService;

  const ORIGIN = { x: -1912, y: 922, z: -167 };
  const LAND = { x: -560, y: 320, z: -140 };

  beforeAll(async () => {
    db = await bootMigratedDb("UtilityInsightsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199640000000n);

    const lineups = new UtilityLineupsService(
      new Logger("UtilityInsightsTest"),
      postgres,
      {} as unknown as never,
      {} as unknown as never,
      {
        pending: jest.fn(async (): Promise<Array<UtilityPendingLineup>> => []),
      } as unknown as never,
      new UtilityCalloutsService(new Logger("UtilityInsightsTest"), postgres),
    );

    insights = new UtilityInsightsService(postgres, lineups);

    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM utility_meta_lineups");
    await postgres.query("DELETE FROM utility_lineup_progress");
    await postgres.query("DELETE FROM utility_lineups");
    await postgres.query("DELETE FROM match_map_demos");
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM team_roster");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
  });

  const user = (steamId: string): User =>
    ({ steam_id: steamId, role: "user", name: "tester" }) as User;

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
      `INSERT INTO utility_lineups (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(row),
    );
    return inserted.id;
  }

  // The cluster the miner would have written for a lineup's bucket. Read back
  // off the lineup itself so the two can never disagree about the key.
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

  async function progressFor(
    lineupId: string,
    steamId: string,
    row: {
      attempts: number;
      successes: number;
      streak?: number;
      mastered?: boolean;
    },
  ): Promise<void> {
    await postgres.query(
      `INSERT INTO utility_lineup_progress
         (utility_lineup_id, steam_id, attempts, successes, current_streak,
          mastered_at)
       VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::int,
               CASE WHEN $6::boolean THEN now() END)`,
      [
        lineupId,
        steamId,
        row.attempts,
        row.successes,
        row.streak ?? 0,
        row.mastered === true,
      ],
    );
  }

  describe("the practice plan", () => {
    it("says the map is un-mined rather than returning an empty plan", async () => {
      const player = await fx.player();
      await insertLineup(player);

      const plan = await insights.practicePlan(user(player), {
        map_name: "de_mirage",
      });

      expect(plan.analysed).toBe(false);
      expect(plan.message).toMatch(/mined/);
      expect(plan.entries).toEqual([]);
    });

    it("ranks the gap between what people throw and what you have drilled", async () => {
      const player = await fx.player();

      const untouched = await insertLineup(player, { name: "untouched" });
      const nearlyThere = await insertLineup(player, {
        name: "nearly",
        land_x: LAND.x + 700,
      });
      const obscure = await insertLineup(player, {
        name: "obscure",
        land_x: LAND.x + 1400,
      });
      const owned = await insertLineup(player, {
        name: "owned",
        land_x: LAND.x + 2100,
      });
      const slipping = await insertLineup(player, {
        name: "slipping",
        land_x: LAND.x + 2800,
      });

      await metaFor(untouched, 20);
      await metaFor(nearlyThere, 10);
      await metaFor(obscure, 2);
      await metaFor(owned, 30);
      await metaFor(slipping, 8);

      await progressFor(nearlyThere, player, { attempts: 10, successes: 8 });
      await progressFor(obscure, player, { attempts: 4, successes: 0 });
      await progressFor(owned, player, {
        attempts: 30,
        successes: 25,
        streak: 6,
        mastered: true,
      });
      await progressFor(slipping, player, {
        attempts: 30,
        successes: 20,
        streak: 0,
        mastered: true,
      });

      const plan = await insights.practicePlan(user(player), {
        map_name: "de_mirage",
      });

      expect(plan.analysed).toBe(true);
      // A lineup they have mastered and are still hitting is not something to
      // learn next, so it is absent rather than last.
      expect(plan.entries.map((entry) => entry.utility_lineup_id)).toEqual([
        untouched,
        slipping,
        nearlyThere,
        obscure,
      ]);
      expect(plan.entries.map((entry) => entry.reason)).toEqual([
        "never_attempted",
        "mastered_slipping",
        "popular_unmastered",
        "unmastered",
      ]);
      expect(plan.entries[0].priority).toBeCloseTo(20, 3);
      expect(plan.entries[0].meta_throwers).toBe(20);
      expect(plan.entries[1].mastered).toBe(true);
      expect(plan.entries[2].attempts).toBe(10);
      expect(plan.entries[2].successes).toBe(8);
    });

    it("only plans lineups the caller can see", async () => {
      const player = await fx.player();
      const stranger = await fx.player();

      const mine = await insertLineup(player, { visibility: "Private" });
      const theirs = await insertLineup(stranger, {
        visibility: "Private",
        land_x: LAND.x + 700,
      });

      await metaFor(mine, 5);
      await metaFor(theirs, 40);

      const plan = await insights.practicePlan(user(player), {
        map_name: "de_mirage",
      });

      expect(plan.entries.map((entry) => entry.utility_lineup_id)).toEqual([mine]);
    });

    it("filters to one side when asked", async () => {
      const player = await fx.player();
      const tSide = await insertLineup(player);
      const ctSide = await insertLineup(player, {
        side: "CT",
        land_x: LAND.x + 700,
      });

      await metaFor(tSide, 5);
      await metaFor(ctSide, 5);

      const plan = await insights.practicePlan(user(player), {
        map_name: "de_mirage",
        side: "CT",
      });

      expect(plan.entries.map((entry) => entry.utility_lineup_id)).toEqual([
        ctSide,
      ]);
    });

    // A popular spot can hold a dozen write-ups of the same throw. A plan that
    // lists all twelve is not a plan.
    it("offers one lineup per meta bucket", async () => {
      const player = await fx.player();
      const best = await insertLineup(player, {
        name: "best",
        upvotes: 40,
      });
      await insertLineup(player, { name: "also", upvotes: 1 });
      await insertLineup(player, { name: "another", upvotes: 3 });

      await metaFor(best, 12);

      const plan = await insights.practicePlan(user(player), {
        map_name: "de_mirage",
      });

      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0].utility_lineup_id).toBe(best);
    });

    it("honours a limit", async () => {
      const player = await fx.player();

      for (let index = 0; index < 4; index++) {
        const lineup = await insertLineup(player, {
          land_x: LAND.x + index * 700,
        });
        await metaFor(lineup, 10 - index);
      }

      const plan = await insights.practicePlan(user(player), {
        map_name: "de_mirage",
        limit: 2,
      });

      expect(plan.entries).toHaveLength(2);
    });

    it("says so when there is genuinely nothing left to drill", async () => {
      const player = await fx.player();
      const lineup = await insertLineup(player);

      await metaFor(lineup, 12);
      await progressFor(lineup, player, {
        attempts: 20,
        successes: 18,
        streak: 7,
        mastered: true,
      });

      const plan = await insights.practicePlan(user(player), {
        map_name: "de_mirage",
      });

      expect(plan.analysed).toBe(true);
      expect(plan.entries).toEqual([]);
      expect(plan.message).toMatch(/already mastered/);
    });

    it("distinguishes a mined map with no lineups you can see", async () => {
      const player = await fx.player();
      const stranger = await fx.player();
      const theirs = await insertLineup(stranger, { visibility: "Private" });

      await metaFor(theirs, 30);

      const plan = await insights.practicePlan(user(player), {
        map_name: "de_mirage",
      });

      expect(plan.analysed).toBe(true);
      expect(plan.entries).toEqual([]);
      expect(plan.message).toMatch(/falls in a bucket the meta has thrown/);
    });
  });

  describe("the team utility report", () => {
    async function demo(): Promise<string> {
      const ctx = await fx.bareMatch();
      const [row] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO match_map_demos (match_id, match_map_id, file, playback_file)
         VALUES ($1::uuid, $2::uuid, 'test.dem', $3)
         RETURNING id::text AS id`,
        [ctx.matchId, ctx.mapId, `demos/${ctx.matchId}/playback.json.gz`],
      );
      return row.id;
    }

    let grenade = 0;

    async function throwOf(
      demoId: string,
      thrower: string,
      overrides: {
        land?: { x: number; y: number; z: number };
        mapName?: string;
      } = {},
    ): Promise<void> {
      const land = overrides.land ?? LAND;
      await postgres.query(
        `INSERT INTO utility_demo_throws
           (match_map_demo_id, grenade_id, map_name, utility_type, side, technique,
            thrower_steam_id, origin_x, origin_y, origin_z,
            land_x, land_y, land_z)
         VALUES ($1::uuid, $2::int, $3, 'Smoke', 'TERRORIST', 'Jump', $4::bigint,
                 $5, $6, $7, $8, $9, $10)`,
        [
          demoId,
          ++grenade,
          overrides.mapName ?? "de_mirage",
          thrower,
          ORIGIN.x,
          ORIGIN.y,
          ORIGIN.z,
          land.x,
          land.y,
          land.z,
        ],
      );
    }

    async function roster(teamId: string): Promise<Array<string>> {
      const rows = await postgres.query<Array<{ steam_id: string }>>(
        `SELECT t.owner_steam_id::text AS steam_id FROM teams t WHERE t.id = $1::uuid
          UNION
         SELECT tr.player_steam_id::text FROM team_roster tr WHERE tr.team_id = $1::uuid`,
        [teamId],
      );
      return rows.map((row) => row.steam_id);
    }

    it("refuses somebody who is not on the team", async () => {
      const team = await fx.team(1);
      const stranger = await fx.player();

      await expect(
        insights.teamUtilityReport(user(stranger), { team_id: team.id }),
      ).rejects.toThrow("not on that team");
    });

    it("refuses a team that does not exist", async () => {
      const player = await fx.player();

      await expect(
        insights.teamUtilityReport(user(player), {
          team_id: "6f8b8b3e-0000-4000-8000-000000000000",
        }),
      ).rejects.toThrow("team not found");
    });

    it("counts how often the roster threw it and how often it landed", async () => {
      const team = await fx.team(2);
      const players = await roster(team.id);
      const lineup = await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });
      const demoId = await demo();

      // Nine on the spot, three in the same 64-unit cell but a long way above
      // it -- the bucket does not look at Z, so these are still "the same
      // lineup" by bucket and still nowhere near the landing point.
      for (const player of players) {
        for (let hit = 0; hit < 3; hit++) {
          await throwOf(demoId, player);
        }
      }
      for (const player of players) {
        await throwOf(demoId, player, {
          land: { ...LAND, z: LAND.z + 150 },
        });
      }

      const report = await insights.teamUtilityReport(user(team.owner), {
        team_id: team.id,
        map_name: "de_mirage",
      });

      expect(report.analysed).toBe(true);
      expect(report.entries).toEqual([
        { utility_lineup_id: lineup, thrown: 12, landed: 9, players: 3 },
      ]);
    });

    // utility_demo_throws names a player and the match they threw in. Nothing
    // finer than a count may leave here, or the action becomes a way around the
    // admin-only select permission on that table.
    it("never hands back a per-player row", async () => {
      const team = await fx.team(2);
      const players = await roster(team.id);
      await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });
      const demoId = await demo();

      for (const player of players) {
        await throwOf(demoId, player);
      }

      const report = await insights.teamUtilityReport(user(team.owner), {
        team_id: team.id,
      });

      const wire = JSON.stringify(report);

      for (const player of players) {
        expect(wire).not.toContain(player);
      }
      expect(Object.keys(report.entries[0])).toEqual([
        "utility_lineup_id",
        "thrown",
        "landed",
        "players",
      ]);
    });

    it("ignores throws by people who are not on the roster", async () => {
      const team = await fx.team(1);
      const outsider = await fx.player();
      const lineup = await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });
      const demoId = await demo();

      await throwOf(demoId, team.owner);
      await throwOf(demoId, outsider);
      await throwOf(demoId, outsider);

      const report = await insights.teamUtilityReport(user(team.owner), {
        team_id: team.id,
      });

      expect(report.entries).toEqual([
        { utility_lineup_id: lineup, thrown: 1, landed: 1, players: 1 },
      ]);
    });

    it("only matches throws to lineups the caller can see", async () => {
      const team = await fx.team(1);
      const stranger = await fx.player();
      await insertLineup(stranger, { visibility: "Private" });
      const demoId = await demo();

      await throwOf(demoId, team.owner);

      const report = await insights.teamUtilityReport(user(team.owner), {
        team_id: team.id,
      });

      expect(report.analysed).toBe(true);
      expect(report.entries).toEqual([]);
      expect(report.message).toMatch(/none of which land in the bucket/);
    });

    it("says nothing has been mined rather than reporting zero", async () => {
      const team = await fx.team(1);
      await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });

      const report = await insights.teamUtilityReport(user(team.owner), {
        team_id: team.id,
      });

      expect(report.analysed).toBe(false);
      expect(report.message).toMatch(/no demo throws have been mined/);
      expect(report.entries).toEqual([]);
    });

    it("scopes to one map when asked", async () => {
      const team = await fx.team(1);
      await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
      });
      const onNuke = await insertLineup(team.owner, {
        visibility: "Team",
        team_id: team.id,
        map_name: "de_nuke",
      });
      const demoId = await demo();

      await throwOf(demoId, team.owner);
      await throwOf(demoId, team.owner);
      await throwOf(demoId, team.owner, { mapName: "de_nuke" });

      const report = await insights.teamUtilityReport(user(team.owner), {
        team_id: team.id,
        map_name: "de_nuke",
      });

      expect(report.entries).toEqual([
        { utility_lineup_id: onNuke, thrown: 1, landed: 1, players: 1 },
      ]);
    });
  });
});
