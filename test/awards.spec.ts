import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { AwardsService } from "./../src/awards/awards.service";
import { AwardsController } from "./../src/awards/awards.controller";
import { Fixtures } from "./utils/fixtures";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Covers the awards layer that sits under tournament placements: the catalog
// fallback, per-tournament overrides, source-scoped recalculation, and the
// constraints that keep a grant pointing at exactly one recipient.
describe("awards (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("AwardsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199600000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM awards WHERE system_key IS NULL");
    // seasons carries an exclusion constraint against overlapping ranges, so
    // leftovers from one test collide with the next one's open-ended season.
    await postgres.query("DELETE FROM seasons");
  });

  const SE4 = [
    { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
  ];

  const playedOutCup = async () => {
    const t = await tfx.launch(SE4, 4);
    await tfx.playRound(t.stageIds[0], 1);
    await tfx.playRound(t.stageIds[0], 2);
    expect(await tfx.tournamentStatus(t.id)).toBe("Finished");
    return t;
  };

  const createAward = async (
    name: string,
    tier = "special",
    allowMultiple = false,
  ) => {
    const [award] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO awards (name, tier, allow_multiple) VALUES ($1, $2, $3) RETURNING id`,
      [name, tier, allowMultiple],
    );
    return award.id;
  };

  const systemAward = async (key: string) => {
    const [award] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM awards WHERE system_key = $1",
      [key],
    );
    return award.id;
  };

  const user = (steam_id: string, role: string) =>
    ({ steam_id, role }) as never;

  const awardsController = (
    getSetting: (name: string) => Promise<string> = async () => "administrator",
  ) =>
    new AwardsController(
      new AwardsService(
        new Logger("AwardsActionTest"),
        // No test touches artwork, so a stub that fails loudly is enough.
        {
          put: jest.fn(),
          remove: jest.fn(),
          has: jest.fn().mockResolvedValue(false),
        } as never,
        postgres,
        { notifyPlayers: jest.fn() } as never,
      ),
      { getSetting } as never,
    );

  describe("catalog", () => {
    it("ships the four tournament system awards", async () => {
      const rows = await postgres.query<
        Array<{ system_key: string; tier: string }>
      >(
        `SELECT system_key, tier FROM awards
          WHERE system_key LIKE 'tournament\\_%' ORDER BY system_key`,
      );
      expect(rows.map((r) => r.system_key)).toEqual([
        "tournament_bronze",
        "tournament_gold",
        "tournament_mvp",
        "tournament_silver",
      ]);
      expect(rows.map((r) => r.tier)).toEqual([
        "bronze",
        "gold",
        "mvp",
        "silver",
      ]);
    });

    it("scopes an award to at most one owner", async () => {
      const t = await playedOutCup();
      const [season] = await postgres.query<Array<{ id: string }>>(
        `INSERT INTO seasons (starts_at) VALUES (now()) RETURNING id`,
      );

      await expect(
        postgres.query(
          `INSERT INTO awards (name, tier, tournament_id, season_id)
            VALUES ('Two Homes', 'special', $1, $2)`,
          [t.id, season.id],
        ),
      ).rejects.toThrow(/single_scope/i);

      await postgres.query(
        `INSERT INTO awards (name, tier, season_id) VALUES ('Season Award', 'special', $1)`,
        [season.id],
      );
      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM awards WHERE season_id = $1",
        [season.id],
      );
      expect(Number(c)).toBe(1);
    });

    it("refuses to scope a built-in award", async () => {
      const t = await playedOutCup();
      await expect(
        postgres.query(
          "UPDATE awards SET tournament_id = $1 WHERE system_key = 'tournament_gold'",
          [t.id],
        ),
      ).rejects.toThrow(/single_scope/i);
    });

    it("rejects a tier outside the enum", async () => {
      await expect(
        postgres.query(
          "INSERT INTO awards (name, tier) VALUES ('Bad', 'plat')",
        ),
      ).rejects.toThrow();
    });

    it("refuses to delete a system award even from raw SQL", async () => {
      await expect(
        postgres.query(
          "DELETE FROM awards WHERE system_key = 'tournament_gold'",
        ),
      ).rejects.toThrow(/cannot be deleted/i);

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM awards WHERE system_key = 'tournament_gold'",
      );
      expect(Number(c)).toBe(1);
    });

    it("still deletes hand-made awards and their grants", async () => {
      const awardId = await createAward("Temporary");
      const steamId = await fx.player();

      await postgres.query(
        `INSERT INTO award_recipients (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, steamId],
      );

      await postgres.query("DELETE FROM awards WHERE id = $1", [awardId]);

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM award_recipients WHERE award_id = $1",
        [awardId],
      );
      expect(Number(c)).toBe(0);
    });
  });

  describe("granting", () => {
    it("requires exactly one recipient", async () => {
      const awardId = await createAward("Clutch King");
      const steamId = await fx.player();
      const team = await fx.team();

      await expect(
        postgres.query(
          "INSERT INTO award_recipients (award_id, source) VALUES ($1, 'manual')",
          [awardId],
        ),
      ).rejects.toThrow(/one_recipient/i);

      await expect(
        postgres.query(
          `INSERT INTO award_recipients (award_id, player_steam_id, team_id, source)
            VALUES ($1, $2, $3, 'manual')`,
          [awardId, steamId, team.id],
        ),
      ).rejects.toThrow(/one_recipient/i);
    });

    it("grants an award with no tournament attached", async () => {
      const awardId = await createAward("Community MVP");
      const steamId = await fx.player();

      await postgres.query(
        `INSERT INTO award_recipients (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, steamId],
      );

      const [row] = await postgres.query<
        Array<{ tournament_id: string | null; placement: number | null }>
      >(
        "SELECT tournament_id, placement FROM award_recipients WHERE award_id = $1",
        [awardId],
      );
      expect(row.tournament_id).toBeNull();
      expect(row.placement).toBeNull();
    });

    it("fans a team grant out to the roster so it reaches player pages", async () => {
      const awardId = await createAward("Squad Honour");
      const team = await fx.team(3);

      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 AND role <> 'Invite'",
        [team.id],
      );
      expect(roster.length).toBeGreaterThan(1);

      await postgres.query(
        `INSERT INTO award_recipients (award_id, team_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, team.id],
      );
      await postgres.query(
        `INSERT INTO award_recipients
            (award_id, player_steam_id, source)
          SELECT $1, r.player_steam_id, 'manual'
            FROM team_roster r
           WHERE r.team_id = $2 AND r.role <> 'Invite'`,
        [awardId, team.id],
      );

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        `SELECT count(*) AS c FROM award_recipients
          WHERE award_id = $1 AND player_steam_id IS NOT NULL`,
        [awardId],
      );
      expect(Number(c)).toBe(roster.length);

      const [{ t }] = await postgres.query<Array<{ t: string }>>(
        `SELECT count(*) AS t FROM award_recipients
          WHERE award_id = $1 AND team_id IS NOT NULL`,
        [awardId],
      );
      expect(Number(t)).toBe(1);
    });

    it("blocks a repeat grant unless the award allows multiples", async () => {
      const onceId = await createAward("One Time Only");
      const manyId = await createAward("Player of the Month", "special", true);
      const steamId = await fx.player();

      const grant = (awardId: string) =>
        postgres.query(
          `INSERT INTO award_recipients (award_id, player_steam_id, source)
            VALUES ($1, $2, 'manual')`,
          [awardId, steamId],
        );

      await grant(onceId);
      await expect(grant(onceId)).rejects.toThrow(/already granted/i);

      await grant(manyId);
      await grant(manyId);
      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM award_recipients WHERE award_id = $1",
        [manyId],
      );
      expect(Number(c)).toBe(2);
    });

    it("blocks a repeat hand-grant inside the same tournament", async () => {
      const t = await playedOutCup();
      const awardId = await createAward("Organizer's Pick");
      const [seat] = await postgres.query<
        Array<{ tournament_team_id: string; player_steam_id: string }>
      >(
        `SELECT tournament_team_id, player_steam_id FROM award_recipients
          WHERE tournament_id = $1 AND player_steam_id IS NOT NULL LIMIT 1`,
        [t.id],
      );

      const grant = () =>
        postgres.query(
          `INSERT INTO award_recipients
              (award_id, tournament_id, tournament_team_id, player_steam_id, source)
            VALUES ($1, $2, $3, $4, 'manual')`,
          [awardId, t.id, seat.tournament_team_id, seat.player_steam_id],
        );

      await grant();
      // Placement is NULL on a hand-grant, so the partial unique keys never
      // bind; the trigger is what stops the duplicate.
      await expect(grant()).rejects.toThrow(/already granted/i);
    });

    it("skips roster members who already hold the award when fanning out", async () => {
      const awardId = await createAward("Squad Honour");
      const team = await fx.team(3);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 AND role <> 'Invite'",
        [team.id],
      );

      // One member already holds it before the team grant fans out.
      await postgres.query(
        `INSERT INTO award_recipients (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, roster[0].player_steam_id],
      );

      await postgres.query(
        `INSERT INTO award_recipients (award_id, player_steam_id, source)
          SELECT $1, r.player_steam_id, 'manual'
            FROM team_roster r
           WHERE r.team_id = $2
             AND r.role <> 'Invite'
             AND NOT EXISTS (
               SELECT 1 FROM award_recipients held
                WHERE held.award_id = $1
                  AND held.player_steam_id = r.player_steam_id
                  AND held.tournament_id IS NOT DISTINCT FROM NULL
             )`,
        [awardId, team.id],
      );

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        `SELECT count(*) AS c FROM award_recipients
          WHERE award_id = $1 AND player_steam_id = $2`,
        [awardId, roster[0].player_steam_id],
      );
      expect(Number(c)).toBe(1);

      const [{ total }] = await postgres.query<Array<{ total: string }>>(
        `SELECT count(*) AS total FROM award_recipients
          WHERE award_id = $1 AND player_steam_id IS NOT NULL`,
        [awardId],
      );
      expect(Number(total)).toBe(roster.length);
    });

    it("refuses a tournament team without its tournament", async () => {
      const awardId = await createAward("Orphan");
      const steamId = await fx.player();

      await expect(
        postgres.query(
          `INSERT INTO award_recipients
              (award_id, player_steam_id, tournament_team_id, source)
            VALUES ($1, $2, gen_random_uuid(), 'manual')`,
          [awardId, steamId],
        ),
      ).rejects.toThrow();
    });
  });

  describe("tournament calculation", () => {
    it("falls back to the system award for each placement", async () => {
      const t = await playedOutCup();

      const rows = await postgres.query<
        Array<{ placement: number; system_key: string }>
      >(
        `SELECT DISTINCT ar.placement, a.system_key
           FROM award_recipients ar
           JOIN awards a ON a.id = ar.award_id
          WHERE ar.tournament_id = $1
          ORDER BY ar.placement`,
        [t.id],
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.system_key).toBe(
          { 0: "tournament_mvp", 1: "tournament_gold", 2: "tournament_silver" }[
            Number(row.placement)
          ] ?? "tournament_bronze",
        );
      }
    });

    it("uses the per-tournament award override when one is configured", async () => {
      const t = await playedOutCup();
      const customId = await createAward("Summer Cup Champion", "gold", true);

      await postgres.query(
        `INSERT INTO tournament_awards (tournament_id, placement, award_id)
          VALUES ($1, 1, $2)`,
        [t.id, customId],
      );
      await postgres.query("SELECT recalculate_tournament_awards($1)", [t.id]);

      const golds = await postgres.query<Array<{ award_id: string }>>(
        `SELECT DISTINCT award_id FROM award_recipients
          WHERE tournament_id = $1 AND placement = 1`,
        [t.id],
      );
      expect(golds.map((g) => g.award_id)).toEqual([customId]);

      // Placements without an override still resolve to their system award.
      const silvers = await postgres.query<Array<{ award_id: string }>>(
        `SELECT DISTINCT award_id FROM award_recipients
          WHERE tournament_id = $1 AND placement = 2`,
        [t.id],
      );
      expect(silvers.map((s) => s.award_id)).toEqual([
        await systemAward("tournament_silver"),
      ]);
    });

    it("rebuilds calculated rows on recalc while hand-granted rows survive", async () => {
      const t = await playedOutCup();
      const awardId = await createAward("Organizer's Pick");

      const [seat] = await postgres.query<
        Array<{ tournament_team_id: string; player_steam_id: string }>
      >(
        `SELECT tournament_team_id, player_steam_id FROM award_recipients
          WHERE tournament_id = $1 AND player_steam_id IS NOT NULL LIMIT 1`,
        [t.id],
      );

      await postgres.query(
        `INSERT INTO award_recipients
            (award_id, tournament_id, tournament_team_id, player_steam_id, source)
          VALUES ($1, $2, $3, $4, 'manual')`,
        [awardId, t.id, seat.tournament_team_id, seat.player_steam_id],
      );

      await postgres.query("SELECT calculate_tournament_awards($1)", [t.id]);

      const [counts] = await postgres.query<
        Array<{ calculated: string; manual: string }>
      >(
        `SELECT
            count(*) FILTER (WHERE source = 'tournament') AS calculated,
            count(*) FILTER (WHERE source = 'manual') AS manual
           FROM award_recipients WHERE tournament_id = $1`,
        [t.id],
      );
      expect(Number(counts.calculated)).toBeGreaterThan(0);
      expect(Number(counts.manual)).toBe(1);
    });
  });

  describe("medal leaderboard", () => {
    type Medals = { mvp: number; gold: number; silver: number; bronze: number };

    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString();

    const medalBoard = async (
      filters: {
        windowDays?: number;
        matchType?: string;
        seasonId?: string;
      } = {},
    ) => {
      const rows = await postgres.query<
        Array<{
          player_steam_id: string;
          value: number;
          secondary_value: number;
          tertiary_value: number;
          matches_played: number;
        }>
      >("SELECT * FROM get_leaderboard('awards', $1, $2, false, NULL, $3)", [
        filters.windowDays ?? 0,
        filters.matchType ?? null,
        filters.seasonId ?? null,
      ]);
      return new Map<string, Medals>(
        rows.map((row) => [
          String(row.player_steam_id),
          {
            mvp: Number(row.matches_played),
            gold: Number(row.value),
            silver: Number(row.secondary_value),
            bronze: Number(row.tertiary_value),
          },
        ]),
      );
    };

    const grant = async (input: {
      award_id: string;
      player_steam_id?: string;
      team_id?: string;
      season_id?: string;
    }) =>
      awardsController().grantAward({
        ...input,
        user: user(await fx.player(), "administrator"),
      });

    it("counts hand-granted awards by their award tier", async () => {
      const steam = await fx.player();

      for (const tier of ["mvp", "gold", "silver", "bronze"]) {
        await grant({
          award_id: await createAward(`Hand ${tier}`, tier),
          player_steam_id: steam,
        });
      }

      expect((await medalBoard()).get(steam)).toEqual({
        mvp: 1,
        gold: 1,
        silver: 1,
        bronze: 1,
      });
    });

    it("counts a team grant once per rostered player and never for the team", async () => {
      const team = await fx.team(2);
      const roster = await postgres.query<Array<{ player_steam_id: string }>>(
        "SELECT player_steam_id FROM team_roster WHERE team_id = $1 AND role <> 'Invite'",
        [team.id],
      );
      expect(roster).toHaveLength(3);

      await grant({
        award_id: await createAward("Squad Gold", "gold"),
        team_id: team.id,
      });

      const board = await medalBoard();
      expect([...board.keys()].sort()).toEqual(
        roster.map((r) => String(r.player_steam_id)).sort(),
      );
      for (const medals of board.values()) {
        expect(medals).toEqual({ mvp: 0, gold: 1, silver: 0, bronze: 0 });
      }
    });

    it("windows hand grants by the date they were granted", async () => {
      const [recent, old] = await fx.players(2);
      const awardId = await createAward("Community Gold", "gold");

      await grant({ award_id: awardId, player_steam_id: recent });
      const stale = await grant({ award_id: awardId, player_steam_id: old });
      await postgres.query(
        "UPDATE award_recipients SET created_at = $2 WHERE id = $1",
        [stale.id, daysAgo(90)],
      );

      expect([...(await medalBoard({ windowDays: 30 })).keys()]).toEqual([
        recent,
      ]);
      expect([...(await medalBoard()).keys()].sort()).toEqual(
        [recent, old].sort(),
      );
    });

    it("counts a season-scoped hand grant on its own season, not the one it was granted during", async () => {
      const past = await fx.season(daysAgo(60), daysAgo(31));
      const current = await fx.season(daysAgo(30));
      const steam = await fx.player();

      await grant({
        award_id: await createAward("Season Gold", "gold"),
        player_steam_id: steam,
        season_id: past,
      });

      expect((await medalBoard({ seasonId: past })).get(steam)).toEqual({
        mvp: 0,
        gold: 1,
        silver: 0,
        bronze: 0,
      });
      expect((await medalBoard({ seasonId: current })).has(steam)).toBe(false);
    });

    it("counts an unscoped hand grant on the season it was granted in", async () => {
      const past = await fx.season(daysAgo(60), daysAgo(31));
      const current = await fx.season(daysAgo(30));
      const steam = await fx.player();

      const granted = await grant({
        award_id: await createAward("Community Gold", "gold"),
        player_steam_id: steam,
      });
      await postgres.query(
        "UPDATE award_recipients SET created_at = $2 WHERE id = $1",
        [granted.id, daysAgo(45)],
      );

      expect((await medalBoard({ seasonId: past })).has(steam)).toBe(true);
      expect((await medalBoard({ seasonId: current })).has(steam)).toBe(false);
    });

    it("leaves special-tier awards off the board", async () => {
      const [holder, specialOnly] = await fx.players(2);

      await grant({
        award_id: await createAward("Community Gold", "gold"),
        player_steam_id: holder,
      });
      await grant({
        award_id: await createAward("Good Sport"),
        player_steam_id: holder,
      });
      await grant({
        award_id: await createAward("Fan Favourite"),
        player_steam_id: specialOnly,
      });

      const board = await medalBoard();
      expect([...board.keys()]).toEqual([holder]);
      expect(board.get(holder)).toEqual({
        mvp: 0,
        gold: 1,
        silver: 0,
        bronze: 0,
      });
    });

    it("drops unscoped hand grants once a match type is picked", async () => {
      const steam = await fx.player();

      await grant({
        award_id: await createAward("Community Gold", "gold"),
        player_steam_id: steam,
      });

      expect((await medalBoard()).has(steam)).toBe(true);
      expect((await medalBoard({ matchType: "Competitive" })).has(steam)).toBe(
        false,
      );
    });

    it("counts an overridden tournament placement by placement, not by the award's tier", async () => {
      const t = await playedOutCup();
      const specialId = await createAward("Summer Cup Champion");

      await postgres.query(
        `INSERT INTO tournament_awards (tournament_id, placement, award_id)
          VALUES ($1, 1, $2)`,
        [t.id, specialId],
      );
      await postgres.query("SELECT recalculate_tournament_awards($1)", [t.id]);

      const champions = await postgres.query<
        Array<{ player_steam_id: string; award_id: string }>
      >(
        `SELECT player_steam_id, award_id FROM award_recipients
          WHERE tournament_id = $1 AND placement = 1
            AND player_steam_id IS NOT NULL`,
        [t.id],
      );
      expect(champions.length).toBeGreaterThan(0);
      expect(new Set(champions.map((c) => c.award_id))).toEqual(
        new Set([specialId]),
      );

      const board = await medalBoard();
      for (const champion of champions) {
        expect(board.get(String(champion.player_steam_id))?.gold).toBe(1);
      }
    });

    it("counts a tier once per tournament however often it was granted there", async () => {
      const t = await playedOutCup();
      const [{ player_steam_id: steam }] = await postgres.query<
        Array<{ player_steam_id: string }>
      >(
        `SELECT r.player_steam_id::text FROM tournament_team_roster r
          WHERE r.tournament_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM award_recipients ar
               WHERE ar.tournament_id = r.tournament_id
                 AND ar.player_steam_id = r.player_steam_id
                 AND ar.placement IN (0, 1)
            )
          LIMIT 1`,
        [t.id],
      );
      const before = (await medalBoard()).get(steam) ?? {
        mvp: 0,
        gold: 0,
        silver: 0,
        bronze: 0,
      };
      const gold = await systemAward("tournament_gold");

      for (let i = 0; i < 3; i++) {
        await awardsController().grantAward({
          award_id: gold,
          player_steam_id: steam,
          tournament_id: t.id,
          user: user(await fx.player(), "administrator"),
        });
      }
      await grant({ award_id: gold, player_steam_id: steam });

      expect((await medalBoard()).get(steam)).toEqual({
        ...before,
        gold: before.gold + 2,
      });
    });

    it("ranks a player where the board's default order places them", async () => {
      const [mvp, doubleGold, goldSilver, gold] = await fx.players(4);
      const mvpAward = await createAward("Hand MVP", "mvp");
      const goldAward = await createAward("Hand Gold", "gold", true);
      const silverAward = await createAward("Hand Silver", "silver");

      await grant({ award_id: mvpAward, player_steam_id: mvp });
      await grant({ award_id: goldAward, player_steam_id: doubleGold });
      await grant({ award_id: goldAward, player_steam_id: doubleGold });
      await grant({ award_id: goldAward, player_steam_id: goldSilver });
      await grant({ award_id: silverAward, player_steam_id: goldSilver });
      await grant({ award_id: goldAward, player_steam_id: gold });

      // The awards order_by in web/pages/leaderboard.vue.
      const board = await postgres.query<Array<{ player_steam_id: string }>>(
        `SELECT player_steam_id FROM get_leaderboard('awards', 0)
          ORDER BY matches_played DESC, value DESC,
                   secondary_value DESC, tertiary_value DESC`,
      );
      expect(board.map((r) => r.player_steam_id)).toEqual([
        mvp,
        doubleGold,
        goldSilver,
        gold,
      ]);

      const ranks: number[] = [];
      for (const steam of [mvp, doubleGold, goldSilver, gold]) {
        const [row] = await postgres.query<Array<{ rank: number }>>(
          "SELECT rank FROM get_player_leaderboard_rank('awards', 0, $1)",
          [steam],
        );
        ranks.push(Number(row?.rank));
      }
      expect(ranks).toEqual([1, 2, 3, 4]);
    });
  });

  describe("season awards", () => {
    const seedSeasonElo = async (
      seasonId: string,
      rows: Array<{ steam: string; elo: number; impact: number }>,
    ) => {
      for (const row of rows) {
        const { matchId } = await fx.bareMatch();
        await postgres.query(
          `INSERT INTO player_elo
              (match_id, steam_id, season_id, type, current, change, impact,
               expected_score, actual_score, k_factor)
            VALUES ($1, $2, $3, 'Competitive', $4, 0, $5, 0.5, 1.0, 32)`,
          [matchId, row.steam, seasonId, row.elo, row.impact],
        );
      }
    };

    it("ships the four season system awards", async () => {
      const rows = await postgres.query<Array<{ system_key: string }>>(
        `SELECT system_key FROM awards
          WHERE system_key LIKE 'season\\_%' ORDER BY system_key`,
      );
      expect(rows.map((r) => r.system_key)).toEqual([
        "season_bronze",
        "season_gold",
        "season_mvp",
        "season_silver",
      ]);
    });

    it("places the top three by season elo and an mvp by impact", async () => {
      const [season] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO seasons (starts_at) VALUES (now()) RETURNING id",
      );
      const players = await fx.players(4);

      // Highest elo is players[0]; highest impact is players[3], so the
      // champion and the MVP must be different people.
      await seedSeasonElo(season.id, [
        { steam: players[0], elo: 1400, impact: 1.0 },
        { steam: players[1], elo: 1300, impact: 1.0 },
        { steam: players[2], elo: 1200, impact: 1.0 },
        { steam: players[3], elo: 1100, impact: 1.9 },
      ]);

      await postgres.query("SELECT calculate_season_awards($1)", [season.id]);

      const rows = await postgres.query<
        Array<{
          placement: number;
          player_steam_id: string;
          system_key: string;
        }>
      >(
        `SELECT ar.placement, ar.player_steam_id, a.system_key
           FROM award_recipients ar
           JOIN awards a ON a.id = ar.award_id
          WHERE ar.season_id = $1 AND ar.source = 'season'
          ORDER BY ar.placement`,
        [season.id],
      );

      expect(rows.map((r) => r.system_key)).toEqual([
        "season_mvp",
        "season_gold",
        "season_silver",
        "season_bronze",
      ]);
      expect(String(rows[0].player_steam_id)).toBe(String(players[3]));
      expect(String(rows[1].player_steam_id)).toBe(String(players[0]));
      expect(String(rows[3].player_steam_id)).toBe(String(players[2]));
    });

    it("counts season medals on the awards leaderboard", async () => {
      const [season] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO seasons (starts_at) VALUES (now()) RETURNING id",
      );
      const players = await fx.players(3);

      await seedSeasonElo(season.id, [
        { steam: players[0], elo: 1400, impact: 1.0 },
        { steam: players[1], elo: 1300, impact: 1.0 },
        { steam: players[2], elo: 1200, impact: 1.0 },
      ]);

      await postgres.query("SELECT calculate_season_awards($1)", [season.id]);

      // value = gold, tertiary_value = bronze, matches_played = mvp.
      const rows = await postgres.query<
        Array<{
          player_steam_id: string;
          value: string;
          tertiary_value: string;
          matches_played: number;
        }>
      >(
        `SELECT player_steam_id, value, tertiary_value, matches_played
           FROM get_leaderboard('awards', 0)`,
      );
      const board = new Map(rows.map((r) => [String(r.player_steam_id), r]));

      const champion = board.get(String(players[0]));
      expect(Number(champion.value)).toBe(1);
      expect(Number(champion.matches_played)).toBe(1);
      expect(Number(board.get(String(players[2])).tertiary_value)).toBe(1);
    });

    it("breaks an elo tie deterministically", async () => {
      const [season] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO seasons (starts_at) VALUES (now()) RETURNING id",
      );
      const players = await fx.players(3);

      await seedSeasonElo(season.id, [
        { steam: players[0], elo: 1200, impact: 1.0 },
        { steam: players[1], elo: 1200, impact: 1.0 },
        { steam: players[2], elo: 1200, impact: 1.0 },
      ]);

      const placements = async () => {
        await postgres.query("SELECT calculate_season_awards($1)", [season.id]);
        const rows = await postgres.query<
          Array<{ placement: number; player_steam_id: string }>
        >(
          `SELECT placement, player_steam_id FROM award_recipients
            WHERE season_id = $1 AND source = 'season' AND placement > 0
            ORDER BY placement`,
          [season.id],
        );
        return rows.map((r) => `${r.placement}:${r.player_steam_id}`);
      };

      expect(await placements()).toEqual(await placements());
    });

    it("recalculates without duplicating, and keeps hand-granted rows", async () => {
      const [season] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO seasons (starts_at) VALUES (now()) RETURNING id",
      );
      const players = await fx.players(3);
      await seedSeasonElo(
        season.id,
        players.map((steam, i) => ({ steam, elo: 1400 - i * 100, impact: 1 })),
      );

      const handId = await createAward("Season Community Pick");
      await postgres.query(
        `INSERT INTO award_recipients (award_id, season_id, player_steam_id, source)
          VALUES ($1, $2, $3, 'manual')`,
        [handId, season.id, players[0]],
      );

      await postgres.query("SELECT calculate_season_awards($1)", [season.id]);
      await postgres.query("SELECT calculate_season_awards($1)", [season.id]);

      const [counts] = await postgres.query<
        Array<{ calculated: string; manual: string }>
      >(
        `SELECT
            count(*) FILTER (WHERE source = 'season') AS calculated,
            count(*) FILTER (WHERE source = 'manual') AS manual
           FROM award_recipients WHERE season_id = $1`,
        [season.id],
      );
      expect(Number(counts.calculated)).toBe(4);
      expect(Number(counts.manual)).toBe(1);
    });

    it("seats awards when a season ends and drops them if it reopens", async () => {
      const [season] = await postgres.query<Array<{ id: string }>>(
        "INSERT INTO seasons (starts_at) VALUES (now() - interval '30 days') RETURNING id",
      );
      const players = await fx.players(3);
      await seedSeasonElo(
        season.id,
        players.map((steam, i) => ({ steam, elo: 1400 - i * 100, impact: 1 })),
      );

      const calculated = async () =>
        Number(
          (
            await postgres.query<Array<{ c: string }>>(
              `SELECT count(*) AS c FROM award_recipients
                WHERE season_id = $1 AND source = 'season'`,
              [season.id],
            )
          )[0].c,
        );

      expect(await calculated()).toBe(0);

      await postgres.query(
        "UPDATE seasons SET ends_at = now() - interval '1 day' WHERE id = $1",
        [season.id],
      );
      expect(await calculated()).toBeGreaterThan(0);

      // Ending a season auto-creates its successor (triggers/seasons.sql), so
      // clear that before reopening or the two ranges overlap.
      await postgres.query("DELETE FROM seasons WHERE id <> $1", [season.id]);
      await postgres.query("UPDATE seasons SET ends_at = NULL WHERE id = $1", [
        season.id,
      ]);
      expect(await calculated()).toBe(0);
    });
  });

  describe("awards_enabled", () => {
    it("round-trips the calculated rows without touching hand-granted ones", async () => {
      const t = await playedOutCup();
      const awardId = await createAward("Organizer's Pick");
      const steamId = await fx.player();

      await postgres.query(
        `INSERT INTO award_recipients (award_id, player_steam_id, source)
          VALUES ($1, $2, 'manual')`,
        [awardId, steamId],
      );

      const calculated = async () =>
        Number(
          (
            await postgres.query<Array<{ c: string }>>(
              `SELECT count(*) AS c FROM award_recipients
                WHERE tournament_id = $1 AND source = 'tournament'`,
              [t.id],
            )
          )[0].c,
        );

      expect(await calculated()).toBeGreaterThan(0);

      await postgres.query(
        "UPDATE tournaments SET awards_enabled = false WHERE id = $1",
        [t.id],
      );
      expect(await calculated()).toBe(0);

      await postgres.query(
        "UPDATE tournaments SET awards_enabled = true WHERE id = $1",
        [t.id],
      );
      expect(await calculated()).toBeGreaterThan(0);

      const [{ c }] = await postgres.query<Array<{ c: string }>>(
        "SELECT count(*) AS c FROM award_recipients WHERE award_id = $1",
        [awardId],
      );
      expect(Number(c)).toBe(1);
    });
  });
  // The table permissions are read-only, so every write path runs through the
  // action layer. These cover the authorization it adds on top of the SQL
  // constraints exercised above.
  describe("actions", () => {
    let controller: AwardsController;
    let createFloor: string;
    let grantFloor: string;

    beforeEach(() => {
      createFloor = "administrator";
      grantFloor = "administrator";

      controller = awardsController(async (name: string) =>
        name.includes("create") ? createFloor : grantFloor,
      );
    });

    const rosterOf = async (tournamentId: string) => {
      const [row] = await postgres.query<
        Array<{ player_steam_id: string; team_id: string }>
      >(
        `SELECT r.player_steam_id, tt.team_id
           FROM tournament_team_roster r
           JOIN tournament_teams tt ON tt.id = r.tournament_team_id
          WHERE r.tournament_id = $1
          LIMIT 1`,
        [tournamentId],
      );
      return row;
    };

    describe("saveAward", () => {
      it("rejects a role below the create floor", async () => {
        const steam = await fx.player();

        await expect(
          controller.saveAward({
            name: "Rejected",
            tier: "special",
            user: user(steam, "user"),
          }),
        ).rejects.toThrow("permission to manage awards");
      });

      it("lets a tournament organizer scope an award to their own tournament", async () => {
        const t = await tfx.createTournament(SE4);
        createFloor = "user";

        const award = await controller.saveAward({
          name: "Organizer's Pick",
          tier: "special",
          tournament_id: t.id,
          user: user(t.organizer, "user"),
        });

        expect(award.tournament_id).toBe(t.id);
      });

      it("refuses to scope an award to someone else's tournament", async () => {
        const t = await tfx.createTournament(SE4);
        const stranger = await fx.player();
        createFloor = "user";

        await expect(
          controller.saveAward({
            name: "Not Mine",
            tier: "special",
            tournament_id: t.id,
            user: user(stranger, "user"),
          }),
        ).rejects.toThrow("Not the tournament organizer");
      });

      it("keeps event, season and league scoping to administrators", async () => {
        const season = await fx.season(new Date().toISOString());
        createFloor = "user";

        await expect(
          controller.saveAward({
            name: "Season Special",
            tier: "special",
            season_id: season,
            user: user(await fx.player(), "tournament_organizer"),
          }),
        ).rejects.toThrow("Only administrators");

        const award = await controller.saveAward({
          name: "Season Special",
          tier: "special",
          season_id: season,
          user: user(await fx.player(), "administrator"),
        });
        expect(award.season_id).toBe(season);
      });
    });

    describe("deleteAward", () => {
      it("refuses to delete a built-in award", async () => {
        await expect(
          controller.deleteAward({
            id: await systemAward("tournament_gold"),
            user: user(await fx.player(), "administrator"),
          }),
        ).rejects.toThrow("cannot be deleted");
      });
    });

    describe("grantAward", () => {
      it("rejects a global grant from a role below the grant floor", async () => {
        const awardId = await createAward("Community Pick");

        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: await fx.player(),
            user: user(await fx.player(), "tournament_organizer"),
          }),
        ).rejects.toThrow("permission to grant awards");
      });

      it("lets an organizer below the floor grant inside their own tournament", async () => {
        const t = await playedOutCup();
        const awardId = await createAward("Clutch King");
        const roster = await rosterOf(t.id);

        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: roster.player_steam_id,
          tournament_id: t.id,
          user: user(t.organizer, "user"),
        });

        expect(granted.id).toBeTruthy();

        // ...but not in a tournament they do not run.
        const other = await tfx.createTournament(SE4);
        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: roster.player_steam_id,
            tournament_id: other.id,
            user: user(t.organizer, "user"),
          }),
        ).rejects.toThrow("Not the tournament organizer");
      });

      it("refuses an organizer below the floor granting to themselves or their own team", async () => {
        const t = await playedOutCup();
        const awardId = await systemAward("tournament_gold");
        const { player_steam_id, team_id } = await rosterOf(t.id);
        const teammate = String(player_steam_id);
        await postgres.query(
          "UPDATE tournaments SET organizer_steam_id = $2 WHERE id = $1",
          [t.id, teammate],
        );

        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: teammate,
            tournament_id: t.id,
            user: user(teammate, "user"),
          }),
        ).rejects.toThrow("cannot grant awards to themselves");
        await expect(
          controller.grantAward({
            award_id: awardId,
            team_id,
            tournament_id: t.id,
            user: user(teammate, "user"),
          }),
        ).rejects.toThrow("cannot grant awards to themselves");

        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: teammate,
          tournament_id: t.id,
          user: user(teammate, "administrator"),
        });
        expect(granted.id).toBeTruthy();
      });

      it("refuses a recipient who never played in the tournament", async () => {
        const t = await playedOutCup();
        const awardId = await createAward("Outsider");

        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: await fx.player(),
            tournament_id: t.id,
            user: user(t.organizer, "user"),
          }),
        ).rejects.toThrow("not part of this tournament");
      });

      it("refuses a grant that names more than one scope", async () => {
        const t = await tfx.createTournament(SE4);
        const season = await fx.season(new Date().toISOString());
        const awardId = await createAward("Confused");

        await expect(
          controller.grantAward({
            award_id: awardId,
            player_steam_id: await fx.player(),
            tournament_id: t.id,
            season_id: season,
            user: user(await fx.player(), "administrator"),
          }),
        ).rejects.toThrow("one scope at most");
      });

      it("stamps the season on a season-scoped grant", async () => {
        const season = await fx.season(new Date().toISOString());
        const awardId = await createAward("Season Special");
        const steam = await fx.player();

        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: steam,
          season_id: season,
          user: user(await fx.player(), "administrator"),
        });

        const [row] = await postgres.query<Array<{ season_id: string }>>(
          "SELECT season_id FROM award_recipients WHERE id = $1",
          [granted.id],
        );
        expect(row.season_id).toBe(season);
      });

      it("lets a granter hand an award to themselves", async () => {
        const granter = await fx.player();
        const awardId = await createAward("Self Nominated");

        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: granter,
          user: user(granter, "administrator"),
        });

        const [row] = await postgres.query<
          Array<{ player_steam_id: string; awarded_by_steam_id: string }>
        >(
          `SELECT player_steam_id, awarded_by_steam_id
             FROM award_recipients WHERE id = $1`,
          [granted.id],
        );
        expect(String(row.player_steam_id)).toBe(granter);
        expect(String(row.awarded_by_steam_id)).toBe(granter);
      });

      it("stores a team grant on the team itself when no tournament is named", async () => {
        const team = await fx.team(2);
        const awardId = await createAward("Squad Honour");
        const [{ roster }] = await postgres.query<Array<{ roster: string }>>(
          `SELECT count(*) AS roster FROM team_roster
            WHERE team_id = $1 AND role <> 'Invite'`,
          [team.id],
        );

        await controller.grantAward({
          award_id: awardId,
          team_id: team.id,
          user: user(await fx.player(), "administrator"),
        });

        const teamRows = await postgres.query<
          Array<{
            player_steam_id: string | null;
            tournament_id: string | null;
            tournament_team_id: string | null;
          }>
        >(
          `SELECT player_steam_id, tournament_id, tournament_team_id
             FROM award_recipients
            WHERE award_id = $1 AND team_id = $2`,
          [awardId, team.id],
        );
        expect(teamRows).toEqual([
          {
            player_steam_id: null,
            tournament_id: null,
            tournament_team_id: null,
          },
        ]);

        const [{ players }] = await postgres.query<Array<{ players: string }>>(
          `SELECT count(*) AS players FROM award_recipients
            WHERE award_id = $1 AND player_steam_id IS NOT NULL`,
          [awardId],
        );
        expect(Number(players)).toBe(Number(roster));
      });
    });

    describe("revokeAward", () => {
      it("refuses to revoke a calculated tournament placement", async () => {
        const t = await playedOutCup();
        const [calculated] = await postgres.query<Array<{ id: string }>>(
          `SELECT id FROM award_recipients
            WHERE tournament_id = $1 AND source = 'tournament' LIMIT 1`,
          [t.id],
        );

        await expect(
          controller.revokeAward({
            id: calculated.id,
            user: user(await fx.player(), "administrator"),
          }),
        ).rejects.toThrow("managed by the tournament");
      });

      it("removes a hand-granted row", async () => {
        const awardId = await createAward("Removable");
        const granted = await controller.grantAward({
          award_id: awardId,
          player_steam_id: await fx.player(),
          user: user(await fx.player(), "administrator"),
        });

        await controller.revokeAward({
          id: granted.id,
          user: user(await fx.player(), "administrator"),
        });

        const rows = await postgres.query<Array<{ id: string }>>(
          "SELECT id FROM award_recipients WHERE id = $1",
          [granted.id],
        );
        expect(rows).toHaveLength(0);
      });
    });
  });
});
