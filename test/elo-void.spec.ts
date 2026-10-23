import { Logger } from "@nestjs/common";
import { DelayedError } from "bullmq";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { User } from "./../src/auth/types/User";
import { CacheService } from "./../src/cache/cache.service";
import { EloCalculation } from "./../src/matches/jobs/EloCalculation";
import { RecomputeAllElo } from "./../src/matches/jobs/RecomputeAllElo";
import { MatchesController } from "./../src/matches/matches.controller";
import { PlayerEloRecomputeService } from "./../src/matches/player-elo-recompute.service";
import { SeasonEloBackfillService } from "./../src/matches/season-elo-backfill.service";
import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { HasuraPermissions } from "./utils/hasura-permissions";
import { TournamentFixtures } from "./utils/tournament-fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// An administrator voiding a played match's ELO, and restoring it: the real
// rating engine, the real full recompute and season rebuild, and a real redis
// behind the recompute's request bookkeeping. The BullMQ queue is the only
// stand-in.
describe("ELO void (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let tfx: TournamentFixtures;
  let container: StartedTestContainer;
  let redis: Redis;
  let cache: CacheService;
  let recompute: PlayerEloRecomputeService;
  let queue: { add: jest.Mock };
  let queued: Array<{
    name: string;
    data: { request?: number };
    opts: { jobId: string };
  }>;
  let runs: number;
  let rebuildSql: Array<string>;
  let failOn: ((sql: string) => boolean) | undefined;
  let notifications: { send: jest.Mock };
  let duringRun: { matchId: string; then: () => Promise<unknown> } | undefined;
  let admin: string;

  const logger = new Logger("EloVoidTest");

  beforeAll(async () => {
    db = await bootMigratedDb("EloVoidTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199510000000n);
    tfx = new TournamentFixtures(postgres, fx);
    await seedRegionWithServer(postgres, "TestA");
    container = await new GenericContainer("redis:8.8-alpine")
      .withExposedPorts(6379)
      .start();
    redis = new IORedis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });
  }, 600_000);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
    await db?.stop();
  });

  // Counts full runs, records what a service sent, lets a test land a write in
  // the middle of a rebuild right before it rebuilds a given match, and can
  // make a query fail. Statements a rebuild runs in its own transaction go
  // through the same checks.
  const watch = (sent: Array<string> = []) => {
    const intercept = async (
      sql: string,
      params?: Parameters<PostgresService["query"]>[1],
    ) => {
      sent.push(sql);
      if (sql.includes("TRUNCATE TABLE player_elo")) {
        runs += 1;
      }
      if (failOn?.(sql)) {
        throw new Error("query failed");
      }
      if (
        duringRun &&
        sql.includes("generate_player_elo_for_match") &&
        params?.[0] === duringRun.matchId
      ) {
        const { then } = duringRun;
        duringRun = undefined;
        await then();
      }
    };

    return {
      query: async (
        sql: string,
        params?: Parameters<PostgresService["query"]>[1],
      ) => {
        await intercept(sql, params);
        return postgres.query(sql, params);
      },
      transaction: <T>(fn: (client: any) => Promise<T>) =>
        postgres.transaction((client) =>
          fn({
            query: async (sql: string, params?: Array<any>) => {
              await intercept(sql, params);
              return client.query(sql, params);
            },
          }),
        ),
    } as unknown as PostgresService;
  };

  // Timings a test shortens so a clock or a timeout fires within it.
  const timings = PlayerEloRecomputeService as unknown as Record<
    string,
    number
  >;
  const TIMINGS = [
    "LOCK_RENEW_MS",
    "ITEM_TIMEOUT_MS",
    "TRUNCATE_LOCK_TIMEOUT_MS",
  ];
  const defaultTimings = Object.fromEntries(
    TIMINGS.map((name) => [name, timings[name]]),
  );

  beforeEach(async () => {
    await redis.flushall();
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM match_options");
    await postgres.query("DELETE FROM teams");
    await postgres.query("DELETE FROM players");
    await postgres.query("DELETE FROM seasons");
    await postgres.query(
      "DELETE FROM settings WHERE name IN ('public.seasons_enabled', 'leaver_elo_penalty')",
    );
    await fx.setting("leaderboard_min_matches", "1");

    cache = new CacheService({ getConnection: () => redis } as any, logger);
    queued = [];
    runs = 0;
    rebuildSql = [];
    failOn = undefined;
    duringRun = undefined;
    notifications = { send: jest.fn() };
    queue = {
      add: jest.fn(async (name, data, opts) => {
        queued.push({ name, data, opts });
      }),
    };

    recompute = new PlayerEloRecomputeService(
      logger,
      watch(rebuildSql),
      cache,
      notifications as any,
      { add: jest.fn() } as any,
      queue as any,
    );

    admin = await fx.player(undefined, "administrator");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.assign(timings, defaultTimings);
  });

  const controller = () =>
    Object.assign(Object.create(MatchesController.prototype), {
      logger,
      postgres,
      playerEloRecompute: recompute,
    }) as MatchesController;

  const asUser = (steamId: string, role: string) =>
    ({ steam_id: steamId, role, name: "admin" }) as User;

  const voidElo = (matchId: string, steamId = admin, role = "administrator") =>
    controller().voidMatchElo({
      match_id: matchId,
      user: asUser(steamId, role),
    });

  const restoreElo = (
    matchId: string,
    steamId = admin,
    role = "administrator",
  ) =>
    controller().restoreMatchElo({
      match_id: matchId,
      user: asUser(steamId, role),
    });

  const backfill = (sent?: Array<string>) =>
    new SeasonEloBackfillService(
      logger,
      watch(sent),
      cache,
      { send: jest.fn() } as any,
      recompute,
      { add: jest.fn() } as any,
    );

  const job = <T>(data: T) => ({
    data,
    token: "token",
    attemptsMade: 0,
    moveToDelayed: jest.fn(),
  });

  // What the RecomputeAllElo worker does with each queued job, in order.
  const work = async () => {
    while (queued.length > 0) {
      const { data } = queued.shift()!;
      await new RecomputeAllElo(recompute).process(job(data) as any);
    }
  };

  const duel = async (
    playerA: string,
    playerB: string,
    {
      winner = "a",
      endedDaysAgo = 1,
    }: { winner?: "a" | "b"; endedDaysAgo?: number } = {},
  ) => {
    const match = await fx.match({ type: "Duel" });
    await fx.lineupPlayer(match.lineup_1_id, playerA);
    await fx.lineupPlayer(match.lineup_2_id, playerB);
    await postgres.query(
      `UPDATE matches SET winning_lineup_id = ${
        winner === "a" ? "lineup_1_id" : "lineup_2_id"
      } WHERE id = $1`,
      [match.id],
    );
    await postgres.query(
      `UPDATE matches SET ended_at = now() - make_interval(days => $2) WHERE id = $1`,
      [match.id, endedDaysAgo],
    );
    await fx.playFirstMap(match.id);
    return match;
  };

  const team = async (
    type: string,
    teamA: Array<string>,
    teamB: Array<string>,
    endedDaysAgo = 1,
  ) => {
    const match = await fx.match({ type });
    for (const steamId of teamA) {
      await fx.lineupPlayer(match.lineup_1_id, steamId);
    }
    for (const steamId of teamB) {
      await fx.lineupPlayer(match.lineup_2_id, steamId);
    }
    await postgres.query(
      `UPDATE matches SET winning_lineup_id = lineup_1_id,
         ended_at = now() - make_interval(days => $2) WHERE id = $1`,
      [match.id, endedDaysAgo],
    );
    await fx.playFirstMap(match.id);
    return match;
  };

  const generate = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{ generate_player_elo_for_match: number }>
    >("SELECT generate_player_elo_for_match($1)", [matchId]);
    return Number(row.generate_player_elo_for_match);
  };

  type EloRow = {
    steam_id: string;
    type: string;
    current: number;
    change: number;
    impact: number | null;
    kills: number | null;
    actual_score: number | null;
    season_id: string | null;
  };

  const rows = async (matchId: string): Promise<Record<string, EloRow>> =>
    Object.fromEntries(
      (
        await postgres.query<Array<EloRow>>(
          `SELECT steam_id::text AS steam_id, "type", current::int AS current,
                  change::int AS change, impact::float8 AS impact,
                  kills::int AS kills, actual_score::float8 AS actual_score,
                  season_id
             FROM player_elo WHERE match_id = $1`,
          [matchId],
        )
      ).map((row) => [row.steam_id, row]),
    );

  const voidState = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{
        status: string;
        elo_voided: boolean;
        elo_voided_at: Date | null;
        elo_voided_by_steam_id: string | null;
      }>
    >(
      `SELECT status, elo_voided, elo_voided_at,
              elo_voided_by_steam_id::text AS elo_voided_by_steam_id
         FROM matches WHERE id = $1`,
      [matchId],
    );
    return row;
  };

  const profileElo = async (steamId: string) => {
    const [row] = await postgres.query<
      Array<{
        elo: Record<string, number | null>;
        peak: Record<string, number | null>;
      }>
    >(
      `SELECT get_player_elo(p) AS elo, get_player_peak_elo(p) AS peak
         FROM players p WHERE steam_id = $1`,
      [steamId],
    );
    return row;
  };

  const leaderboard = async (
    windowDays: number,
    excludeTournaments: boolean,
    seasonId: string | null = null,
  ) =>
    Object.fromEntries(
      (
        await postgres.query<
          Array<{
            player_steam_id: string;
            value: number;
            matches_played: number;
          }>
        >(
          `SELECT player_steam_id, value, matches_played
             FROM get_leaderboard('elo', $1, 'Duel', $2, NULL, $3::uuid)`,
          [windowDays, excludeTournaments, seasonId],
        )
      ).map((row) => [row.player_steam_id, row]),
    );

  // The three ways onto the ELO board: All Time, a rolling window, and the
  // tournaments-excluded ladder.
  const boards = () =>
    Promise.all([
      leaderboard(0, false),
      leaderboard(30, false),
      leaderboard(0, true),
    ]);

  describe("the rating engine", () => {
    it("rates a voided match as no change for anyone, at the rating each went in with", async () => {
      const [a, b, c, d] = await fx.players(4);
      const first = await team("Wingman", [a, b], [c, d], 3);
      await generate(first.id);
      const going = await rows(first.id);
      expect(going[a].change).not.toBe(0);
      expect(going[c].change).not.toBe(0);

      const cheated = await team("Wingman", [a, b], [c, d], 2);
      const [map] = await postgres.query<Array<{ id: string }>>(
        `SELECT id FROM match_maps WHERE match_id = $1 ORDER BY "order" LIMIT 1`,
        [cheated.id],
      );
      const ctx = { matchId: cheated.id, mapId: map.id };
      await fx.kill(ctx, a, c, { time: new Date().toISOString() });
      await fx.kill(ctx, b, d, { time: new Date().toISOString() });
      await fx.damage(ctx, a, c, 100);

      await voidElo(cheated.id);
      expect(await generate(cheated.id)).toBe(4);

      const voided = await rows(cheated.id);
      for (const player of [a, b, c, d]) {
        expect(voided[player].change).toBe(0);
        expect(voided[player].current).toBe(going[player].current);
        expect(voided[player].impact).not.toBeNull();
      }
      expect(voided[a].kills).toBe(1);
      expect(voided[a].actual_score).toBe(1);
      expect(voided[c].actual_score).toBe(0);
    });

    it("voids the leaver penalty too", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await postgres.query(
        "INSERT INTO abandoned_matches (steam_id, match_id) VALUES ($1, $2)",
        [b, match.id],
      );

      await voidElo(match.id);
      await generate(match.id);

      const voided = await rows(match.id);
      expect(voided[b].change).toBe(0);
      expect(voided[b].current).toBe(5000);
    });

    it("starts the next match from the rating going into the voided one", async () => {
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 3 });
      const cheated = await duel(a, b, { endedDaysAgo: 2 });
      const next = await duel(a, b, { winner: "b", endedDaysAgo: 1 });

      await generate(first.id);
      await voidElo(cheated.id);
      await generate(cheated.id);
      await generate(next.id);

      const before = await rows(first.id);
      const after = await rows(next.id);
      for (const player of [a, b]) {
        expect(after[player].current - after[player].change).toBe(
          before[player].current,
        );
      }
    });

    it("keeps the match voided through a full recompute", async () => {
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 3 });
      const cheated = await duel(a, b, { endedDaysAgo: 2 });
      const next = await duel(a, b, { winner: "b", endedDaysAgo: 1 });

      await voidElo(cheated.id);
      await work();
      expect(runs).toBe(1);

      const r1 = await rows(first.id);
      const r2 = await rows(cheated.id);
      const r3 = await rows(next.id);
      for (const player of [a, b]) {
        expect(r1[player].change).not.toBe(0);
        expect(r2[player].change).toBe(0);
        expect(r2[player].current).toBe(r1[player].current);
        expect(r3[player].current - r3[player].change).toBe(r1[player].current);
      }
    });

    it("voids a Rush match on the Rush ladder", async () => {
      const teamA = await fx.players(3);
      const teamB = await fx.players(3);
      const match = await team("Rush", teamA, teamB);

      await voidElo(match.id);
      expect(await generate(match.id)).toBe(6);

      const voided = Object.values(await rows(match.id));
      expect(voided.every((row) => row.type === "Rush")).toBe(true);
      expect(voided.every((row) => row.change === 0)).toBe(true);

      const profile = await profileElo(teamA[0]);
      expect(profile.elo.rush).toBeNull();
      expect(profile.peak.rush).toBeNull();
    });

    it("changes nothing for a match that was never rated, even flagged", async () => {
      const [a, b] = await fx.players(2);
      const imported = await duel(a, b);
      await postgres.query(
        "UPDATE matches SET source = 'faceit', elo_voided = true WHERE id = $1",
        [imported.id],
      );

      expect(await generate(imported.id)).toBe(0);
      expect(Object.keys(await rows(imported.id))).toHaveLength(0);
    });
  });

  describe("what a voided match is not", () => {
    it("is nobody's peak", async () => {
      const [a, b] = await fx.players(2);
      const cheated = await duel(a, b, { endedDaysAgo: 2 });
      const next = await duel(a, b, { winner: "b", endedDaysAgo: 1 });

      await voidElo(cheated.id);
      await work();

      const lost = (await rows(next.id))[a];
      expect(lost.change).toBeLessThan(0);
      expect(Number((await profileElo(a)).peak.duel)).toBe(lost.current);
      expect((await leaderboard(0, false))[a].value).toBe(lost.current);
      expect((await leaderboard(0, true))[a].value).toBe(lost.current);
    });

    it("does not stand in for a lifetime rating at the start of a season", async () => {
      await fx.enableSeasons();
      await fx.season("2025-06-01", null);
      await fx.season("2025-01-01", "2025-06-01");
      const [a, b] = await fx.players(2);

      const lastSeason = await duel(a, b);
      await postgres.query(
        "UPDATE matches SET ended_at = '2025-03-01' WHERE id = $1",
        [lastSeason.id],
      );
      await generate(lastSeason.id);
      const lifetime = (await rows(lastSeason.id))[a].current;
      expect(lifetime).toBeGreaterThan(5000);

      const cheated = await duel(a, b);
      await voidElo(cheated.id);
      await generate(cheated.id);
      expect((await rows(cheated.id))[a].current).toBe(5000);

      expect(Number((await profileElo(a)).elo.duel)).toBe(lifetime);
    });

    it("puts nobody on the ELO board and is not a match played", async () => {
      const [a, b, c, d] = await fx.players(4);
      const onlyVoided = await duel(a, b, { endedDaysAgo: 2 });
      const rated = await duel(c, d, { endedDaysAgo: 2 });
      const alsoVoided = await duel(c, d, { endedDaysAgo: 1 });

      await voidElo(onlyVoided.id);
      await voidElo(alsoVoided.id);
      await work();
      expect(Object.keys(await rows(rated.id))).toHaveLength(2);

      for (const board of await boards()) {
        expect(board[a]).toBeUndefined();
        expect(board[b]).toBeUndefined();
        expect(board[c].matches_played).toBe(1);
        expect(board[d].matches_played).toBe(1);
      }
    });

    it("puts nobody on the active season's board and is not a season match played", async () => {
      await fx.enableSeasons();
      const season = await fx.season("2025-01-01", null);
      const [a, b, c, d] = await fx.players(4);
      const onlyVoided = await duel(a, b, { endedDaysAgo: 2 });
      await duel(c, d, { endedDaysAgo: 2 });
      const alsoVoided = await duel(c, d, { endedDaysAgo: 1 });

      await voidElo(onlyVoided.id);
      await voidElo(alsoVoided.id);
      await work();

      const board = await leaderboard(0, false, season);
      expect(board[a]).toBeUndefined();
      expect(board[b]).toBeUndefined();
      expect(board[c].matches_played).toBe(1);
      expect(board[d].matches_played).toBe(1);
    });
  });

  describe("seasons", () => {
    it("voids a season match on the season ladder, and the season rebuild keeps it voided", async () => {
      await fx.enableSeasons();
      const season = await fx.season("2025-01-01", null);
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 3 });
      const cheated = await duel(a, b, { endedDaysAgo: 2 });
      const next = await duel(a, b, { winner: "b", endedDaysAgo: 1 });
      for (const match of [first, cheated, next]) {
        await generate(match.id);
      }

      await voidElo(cheated.id);
      expect(await backfill().runBackfill(season)).toBe(true);

      const check = async () => {
        const r1 = await rows(first.id);
        const r2 = await rows(cheated.id);
        const r3 = await rows(next.id);
        for (const player of [a, b]) {
          expect(r2[player].season_id).toBe(season);
          expect(r2[player].change).toBe(0);
          expect(r2[player].current).toBe(r1[player].current);
          expect(r3[player].current - r3[player].change).toBe(
            r1[player].current,
          );
        }
      };

      await check();
      await work();
      await check();
    });
  });

  describe("tournaments", () => {
    const SE4 = [
      { type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 },
    ];

    it("voids a tournament match on the tournament track and leaves its result, bracket and MVP standing alone", async () => {
      await fx.enableSeasons();
      await fx.season("2025-01-01", null);
      const t = await tfx.launch(SE4, 4);
      const stageId = t.stageIds[0];
      const semi = (await tfx.getBrackets(stageId)).find(
        (bracket) => bracket.round === 1,
      )!;
      await tfx.winMatch(semi.match_id!);
      await fx.playFirstMap(semi.match_id!);

      const snapshot = async () => ({
        match: await postgres.query(
          "SELECT status, winning_lineup_id, ended_at FROM matches WHERE id = $1",
          [semi.match_id],
        ),
        brackets: await tfx.getBrackets(stageId),
      });
      const before = await snapshot();

      await voidElo(semi.match_id!);
      expect(await snapshot()).toEqual(before);

      expect(await generate(semi.match_id!)).toBeGreaterThan(0);
      const voided = Object.values(await rows(semi.match_id!));
      expect(voided.every((row) => row.season_id === null)).toBe(true);
      expect(voided.every((row) => row.change === 0)).toBe(true);

      const champion = semi.tournament_team_id_1;
      await tfx.playStage(stageId, (bracket) =>
        bracket.tournament_team_id_2 === champion
          ? "lineup_2_id"
          : "lineup_1_id",
      );
      for (const bracket of await tfx.getBrackets(stageId)) {
        if (bracket.match_id && bracket.match_id !== semi.match_id) {
          await fx.playFirstMap(bracket.match_id);
          await generate(bracket.match_id);
        }
      }

      const candidates = await postgres.query<
        Array<{ tournament_team_id: string; matches: number }>
      >(
        "SELECT tournament_team_id, matches FROM tournament_mvp_candidates($1)",
        [t.id],
      );
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(candidate.tournament_team_id).toBe(champion);
        expect(candidate.matches).toBe(2);
      }
    });

    it("keeps the void when a reset hands the match to the other side, and clears it when the match is replayed", async () => {
      const t = await tfx.launch(SE4, 4);
      const stageId = t.stageIds[0];
      await tfx.playRound(stageId, 1);
      const semi = (await tfx.getBrackets(stageId)).find(
        (bracket) => bracket.round === 1,
      )!;
      const [match] = await postgres.query<Array<{ lineup_2_id: string }>>(
        "SELECT lineup_2_id FROM matches WHERE id = $1",
        [semi.match_id],
      );

      await voidElo(semi.match_id!);
      const voided = await voidState(semi.match_id!);

      await postgres.query(
        "SELECT * FROM reset_tournament_match($1, $2, 'WaitingForCheckIn', NULL)",
        [semi.match_id, match.lineup_2_id],
      );
      expect(await voidState(semi.match_id!)).toEqual(voided);

      await postgres.query(
        "SELECT * FROM reset_tournament_match($1, NULL, 'WaitingForCheckIn', NULL)",
        [semi.match_id],
      );
      expect(await voidState(semi.match_id!)).toEqual(
        expect.objectContaining({
          elo_voided: false,
          elo_voided_at: null,
          elo_voided_by_steam_id: null,
        }),
      );
    });
  });

  const STAFF_BELOW_ADMIN = [
    "user",
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
  ];

  describe("voidMatchElo", () => {
    it.each(STAFF_BELOW_ADMIN)(
      "refuses a %s even when called directly",
      async (role) => {
        const [a, b] = await fx.players(2);
        const match = await duel(a, b);
        const caller = await fx.player(undefined, role);

        await expect(voidElo(match.id, caller, role)).rejects.toThrow(
          "you must be an administrator",
        );

        expect((await voidState(match.id)).elo_voided).toBe(false);
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it.each(["Finished", "Forfeit", "Surrendered"])(
      "voids a %s match, recording who voided it and when",
      async (status) => {
        const [a, b] = await fx.players(2);
        const match = await duel(a, b);
        await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
          match.id,
          status,
        ]);

        await expect(voidElo(match.id)).resolves.toEqual({ success: true });

        const state = await voidState(match.id);
        expect(state.status).toBe(status);
        expect(state.elo_voided).toBe(true);
        expect(state.elo_voided_at).not.toBeNull();
        expect(state.elo_voided_by_steam_id).toBe(admin);
        expect(queue.add).toHaveBeenCalledTimes(1);
        expect(queued[0].data).toEqual({ request: 1 });
        expect(queued[0].opts).toEqual(
          expect.objectContaining({
            jobId: PlayerEloRecomputeService.jobId(1),
            removeOnComplete: true,
            removeOnFail: true,
          }),
        );
      },
    );

    it.each(["Canceled", "WaitingForCheckIn", "Veto"])(
      "refuses a %s match",
      async (status) => {
        const match = await fx.match({ type: "Duel" });
        await postgres.query("UPDATE matches SET status = $2 WHERE id = $1", [
          match.id,
          status,
        ]);

        await expect(voidElo(match.id)).rejects.toThrow(
          "only a finished match can have its ELO voided",
        );

        expect((await voidState(match.id)).elo_voided).toBe(false);
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it("refuses a match still being set up", async () => {
      const match = await fx.match({ type: "Duel" });

      await expect(voidElo(match.id)).rejects.toThrow(
        "only a finished match can have its ELO voided",
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each([
      ["an imported", "UPDATE matches SET source = 'faceit' WHERE id = $1"],
      [
        "an unranked",
        "UPDATE matches SET counts_toward_ranking = false WHERE id = $1",
      ],
      [
        "a tied",
        "UPDATE matches SET winning_lineup_id = NULL, status = 'Tie' WHERE id = $1",
      ],
    ])("refuses %s match, which never counted toward ELO", async (_, sql) => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await postgres.query(sql, [match.id]);

      await expect(voidElo(match.id)).rejects.toThrow(
        "this match never counted toward ELO",
      );

      expect((await voidState(match.id)).elo_voided).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("refuses a match that does not exist", async () => {
      await expect(
        voidElo("00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow("match not found");
    });

    it("asks for the recompute again when repeated, and both requests fold into one run", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);

      await voidElo(match.id);
      const first = await voidState(match.id);
      const other = await fx.player(undefined, "administrator");
      await expect(voidElo(match.id, other)).resolves.toEqual({
        success: true,
      });

      expect(await voidState(match.id)).toEqual(first);
      expect(queued).toHaveLength(2);
      await work();
      expect(runs).toBe(1);
    });

    it("recovers a void whose recompute request failed when it is repeated", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      queue.add.mockRejectedValueOnce(new Error("redis went away"));

      await expect(voidElo(match.id)).rejects.toThrow("redis went away");
      expect((await voidState(match.id)).elo_voided).toBe(true);
      expect(queued).toHaveLength(0);

      await expect(voidElo(match.id)).resolves.toEqual({ success: true });
      await work();

      expect(runs).toBe(1);
      expect((await rows(match.id))[a].change).toBe(0);
    });

    it("only moves the request counter once the void is committed", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      const seen: Array<boolean> = [];
      const increment = cache.increment.bind(cache);
      jest.spyOn(cache, "increment").mockImplementation(async (key) => {
        seen.push((await voidState(match.id)).elo_voided);
        return increment(key);
      });

      await voidElo(match.id);

      expect(seen).toEqual([true]);
    });

    it("lets exactly one of two simultaneous voids through", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      const other = await fx.player(undefined, "administrator");
      const log = jest.spyOn(logger, "log");

      await expect(
        Promise.all([voidElo(match.id), voidElo(match.id, other)]),
      ).resolves.toEqual([{ success: true }, { success: true }]);

      expect(
        log.mock.calls.filter(([message]) =>
          String(message).includes("ELO voided by"),
        ),
      ).toHaveLength(1);
      expect([admin, other]).toContain(
        (await voidState(match.id)).elo_voided_by_steam_id,
      );
      await work();
      expect(runs).toBe(1);
    });
  });

  describe("restoreMatchElo", () => {
    it.each(STAFF_BELOW_ADMIN)(
      "refuses a %s even when called directly",
      async (role) => {
        const [a, b] = await fx.players(2);
        const match = await duel(a, b);
        await voidElo(match.id);
        queue.add.mockClear();
        const caller = await fx.player(undefined, role);

        await expect(restoreElo(match.id, caller, role)).rejects.toThrow(
          "you must be an administrator",
        );

        expect((await voidState(match.id)).elo_voided).toBe(true);
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it("gives a voided match its rating effect back", async () => {
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 3 });
      const cheated = await duel(a, b, { endedDaysAgo: 2 });
      const next = await duel(a, b, { winner: "b", endedDaysAgo: 1 });
      await voidElo(cheated.id);
      await work();
      expect((await rows(cheated.id))[a].change).toBe(0);

      await expect(restoreElo(cheated.id)).resolves.toEqual({
        success: true,
      });
      expect(await voidState(cheated.id)).toEqual(
        expect.objectContaining({
          elo_voided: false,
          elo_voided_at: null,
          elo_voided_by_steam_id: null,
        }),
      );
      expect(queued).toHaveLength(1);
      await work();

      const r1 = await rows(first.id);
      const r2 = await rows(cheated.id);
      const r3 = await rows(next.id);
      for (const player of [a, b]) {
        expect(r2[player].change).not.toBe(0);
        expect(r2[player].current - r2[player].change).toBe(r1[player].current);
        expect(r3[player].current - r3[player].change).toBe(r2[player].current);
      }
    });

    it("refuses a match that does not exist", async () => {
      await expect(
        restoreElo("00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow("match not found");
    });

    it("asks for the recompute again when repeated, and both requests fold into one run", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await voidElo(match.id);
      await work();
      runs = 0;

      await restoreElo(match.id);
      await expect(restoreElo(match.id)).resolves.toEqual({ success: true });

      expect(queued).toHaveLength(2);
      await work();
      expect(runs).toBe(1);
      expect((await rows(match.id))[a].change).not.toBe(0);
    });

    it("only moves the request counter once the restore is committed", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await voidElo(match.id);
      const seen: Array<boolean> = [];
      const increment = cache.increment.bind(cache);
      jest.spyOn(cache, "increment").mockImplementation(async (key) => {
        seen.push((await voidState(match.id)).elo_voided);
        return increment(key);
      });

      await restoreElo(match.id);

      expect(seen).toEqual([false]);
    });

    it("lets exactly one of two simultaneous restores through", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await voidElo(match.id);
      await work();
      runs = 0;
      const other = await fx.player(undefined, "administrator");
      const log = jest.spyOn(logger, "log");

      await expect(
        Promise.all([restoreElo(match.id), restoreElo(match.id, other)]),
      ).resolves.toEqual([{ success: true }, { success: true }]);

      expect(
        log.mock.calls.filter(([message]) =>
          String(message).includes("ELO restored by"),
        ),
      ).toHaveLength(1);
      expect((await voidState(match.id)).elo_voided).toBe(false);
      await work();
      expect(runs).toBe(1);
    });
  });

  describe("the recompute a void asks for", () => {
    it("follows a run that was already going with exactly one more", async () => {
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 4 });
      const cheated = await duel(a, b, { endedDaysAgo: 3 });
      const alsoCheated = await duel(a, b, { endedDaysAgo: 2 });
      const next = await duel(a, b, { winner: "b", endedDaysAgo: 1 });

      await controller().recomputePlayerElo();
      duringRun = {
        matchId: next.id,
        then: async () => {
          await voidElo(cheated.id);
          await voidElo(alsoCheated.id);
        },
      };
      await work();

      expect(runs).toBe(2);
      expect((await recompute.getStatus()).running).toBe(false);

      const r1 = await rows(first.id);
      const r4 = await rows(next.id);
      for (const player of [a, b]) {
        expect((await rows(cheated.id))[player].change).toBe(0);
        expect((await rows(alsoCheated.id))[player].change).toBe(0);
        expect(r4[player].current - r4[player].change).toBe(r1[player].current);
      }
    });

    it("covers every request made before it started with one run", async () => {
      const [a, b] = await fx.players(2);
      const cheated = await duel(a, b, { endedDaysAgo: 2 });
      const alsoCheated = await duel(a, b, { endedDaysAgo: 1 });

      await voidElo(cheated.id);
      await voidElo(alsoCheated.id);
      expect(queued).toHaveLength(2);
      await work();

      expect(runs).toBe(1);
      expect((await recompute.getStatus()).running).toBe(false);
      for (const player of [a, b]) {
        expect((await rows(cheated.id))[player].change).toBe(0);
        expect((await rows(alsoCheated.id))[player].change).toBe(0);
      }
    });

    it("still runs the requests a canceled run started with", async () => {
      const [a, b] = await fx.players(2);
      const cheated = await duel(a, b, { endedDaysAgo: 2 });
      const alsoCheated = await duel(a, b, { endedDaysAgo: 1 });

      await voidElo(cheated.id);
      await voidElo(alsoCheated.id);
      duringRun = {
        matchId: cheated.id,
        then: () => recompute.requestCancel(),
      };
      await work();

      expect(runs).toBe(2);
      for (const player of [a, b]) {
        expect((await rows(cheated.id))[player].change).toBe(0);
        expect((await rows(alsoCheated.id))[player].change).toBe(0);
      }
    });

    it("retries rather than drops a request while another run holds the lock", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      const holder = await cache.acquireLock("elo-recompute:lock", 60);

      await voidElo(match.id);
      const held = job(queued[0].data);
      await expect(
        new RecomputeAllElo(recompute).process(held as any),
      ).rejects.toBeInstanceOf(DelayedError);
      expect(held.moveToDelayed).toHaveBeenCalledWith(
        expect.any(Number),
        "token",
      );
      expect(runs).toBe(0);

      await cache.releaseLock("elo-recompute:lock", holder!);
      await new RecomputeAllElo(recompute).process(held as any);

      expect(runs).toBe(1);
      expect((await rows(match.id))[a].change).toBe(0);
    });
  });

  describe("a match that finishes during a rebuild", () => {
    const rate = (matchId: string) =>
      new EloCalculation(logger, postgres, recompute).process(
        job({ matchId }) as any,
      );

    it("is rated from the rebuilt ratings by the run it finished during", async () => {
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 2 });
      let late: { id: string } | undefined;

      await controller().recomputePlayerElo();
      duringRun = {
        matchId: first.id,
        then: async () => {
          late = await duel(a, b, { winner: "b", endedDaysAgo: 0 });
          await expect(rate(late.id)).rejects.toBeInstanceOf(DelayedError);
        },
      };
      await work();

      expect(runs).toBe(1);
      const before = await rows(first.id);
      const after = await rows(late!.id);
      for (const player of [a, b]) {
        expect(after[player]).toBeDefined();
        expect(after[player].current - after[player].change).toBe(
          before[player].current,
        );
      }

      await rate(late!.id);
      expect(await rows(late!.id)).toEqual(after);
    });

    it("never lets a season rebuild run inside a full rebuild", async () => {
      await fx.enableSeasons();
      const season = await fx.season("2025-01-01", null);
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await generate(match.id);
      const sent: Array<string> = [];
      const seasonRebuild = backfill(sent);

      await controller().recomputePlayerElo();
      duringRun = {
        matchId: match.id,
        then: async () => {
          expect(await seasonRebuild.runBackfill(season)).toBe(false);
        },
      };
      await work();

      expect(runs).toBe(1);
      expect(sent.some((sql) => sql.includes("DELETE FROM player_elo"))).toBe(
        false,
      );
      expect(await seasonRebuild.runBackfill(season)).toBe(true);
    });

    it("never lets a full rebuild or a match's own rating run inside a season rebuild", async () => {
      await fx.enableSeasons();
      const season = await fx.season("2025-01-01", null);
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await generate(match.id);
      await controller().recomputePlayerElo();
      const held = job(queued.shift()!.data);

      duringRun = {
        matchId: match.id,
        then: async () => {
          await expect(
            new RecomputeAllElo(recompute).process(held as any),
          ).rejects.toBeInstanceOf(DelayedError);
          await expect(rate(match.id)).rejects.toBeInstanceOf(DelayedError);
        },
      };
      expect(await backfill().runBackfill(season)).toBe(true);
      expect(runs).toBe(0);

      await new RecomputeAllElo(recompute).process(held as any);
      expect(runs).toBe(1);
    });

    const finishedMinutesAgo = (matchId: string, minutes: number) =>
      postgres.query(
        "UPDATE matches SET ended_at = now() - make_interval(mins => $2) WHERE id = $1",
        [matchId, minutes],
      );

    // Two matches by the same players finish while a season rebuild holds the
    // lock, and their own ratings are woken in the wrong order afterwards.
    const finishOutOfOrderDuring = async (
      seasonRebuild: () => Promise<unknown>,
      during: string,
      a: string,
      b: string,
    ) => {
      let first: { id: string } | undefined;
      let second: { id: string } | undefined;
      duringRun = {
        matchId: during,
        then: async () => {
          first = await duel(a, b);
          await finishedMinutesAgo(first.id, 2);
          second = await duel(a, b, { winner: "b" });
          await finishedMinutesAgo(second.id, 1);
          await expect(rate(second.id)).rejects.toBeInstanceOf(DelayedError);
          await expect(rate(first.id)).rejects.toBeInstanceOf(DelayedError);
        },
      };
      await seasonRebuild();

      await rate(second!.id);
      await rate(first!.id);

      return { first: first!, second: second! };
    };

    it("is rated in the order it finished by a season rebuild of its own season", async () => {
      await fx.enableSeasons();
      const season = await fx.season("2025-01-01", null);
      const [a, b] = await fx.players(2);
      const earlier = await duel(a, b, { endedDaysAgo: 3 });
      await generate(earlier.id);

      const { first, second } = await finishOutOfOrderDuring(
        async () => expect(await backfill().runBackfill(season)).toBe(true),
        earlier.id,
        a,
        b,
      );

      const r0 = await rows(earlier.id);
      const r1 = await rows(first.id);
      const r2 = await rows(second.id);
      for (const player of [a, b]) {
        expect(r1[player].current - r1[player].change).toBe(r0[player].current);
        expect(r2[player].current - r2[player].change).toBe(r1[player].current);
      }
    });

    it("is rated in the order it finished by a season rebuild of another season", async () => {
      await fx.enableSeasons();
      await fx.season("2025-06-01", null);
      const past = await fx.season("2025-01-01", "2025-06-01");
      const [a, b] = await fx.players(2);
      const lastSeason = await duel(a, b);
      await postgres.query(
        "UPDATE matches SET ended_at = '2025-03-01' WHERE id = $1",
        [lastSeason.id],
      );
      await generate(lastSeason.id);

      const { first, second } = await finishOutOfOrderDuring(
        async () => expect(await backfill().runBackfill(past)).toBe(true),
        lastSeason.id,
        a,
        b,
      );

      const r1 = await rows(first.id);
      const r2 = await rows(second.id);
      for (const player of [a, b]) {
        expect(r1[player].current - r1[player].change).toBe(5000);
        expect(r2[player].current - r2[player].change).toBe(r1[player].current);
      }
    });
  });

  describe("the deferred ratings", () => {
    it("are rated even by a rebuild whose own list is empty", async () => {
      await fx.enableSeasons();
      await fx.season("2025-06-01", null);
      const empty = await fx.season("2025-01-01", "2025-06-01");
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await recompute.deferRating(match.id);

      expect(await backfill().runBackfill(empty)).toBe(true);

      expect(Object.keys(await rows(match.id))).toHaveLength(2);
      expect(await redis.smembers("elo-recompute:deferred-ratings")).toEqual(
        [],
      );
    });
  });

  describe("the rebuild lock", () => {
    const LOCK = "elo-recompute:lock";
    const generated = () =>
      rebuildSql.filter((sql) => sql.includes("generate_player_elo_for_match"))
        .length;

    it("stops a full rebuild that lost its lock before it writes anything more", async () => {
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 3 });
      await duel(a, b, { endedDaysAgo: 2 });
      await duel(a, b, { endedDaysAgo: 1 });

      await controller().recomputePlayerElo();
      const held = job(queued.shift()!.data);
      duringRun = {
        matchId: first.id,
        then: () => redis.set(LOCK, "another-rebuild"),
      };

      await expect(
        new RecomputeAllElo(recompute).process(held as any),
      ).rejects.toBeInstanceOf(DelayedError);
      expect(generated()).toBe(1);
      expect(await redis.get(LOCK)).toBe("another-rebuild");

      await redis.del(LOCK);
      await new RecomputeAllElo(recompute).process(held as any);
      expect(generated()).toBe(4);
    });

    it("stops a season rebuild that lost its lock before it writes anything more", async () => {
      await fx.enableSeasons();
      const season = await fx.season("2025-01-01", null);
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 3 });
      const second = await duel(a, b, { endedDaysAgo: 2 });
      for (const match of [first, second]) {
        await generate(match.id);
      }
      duringRun = {
        matchId: first.id,
        then: () => redis.set(LOCK, "another-rebuild"),
      };

      expect(await backfill().runBackfill(season)).toBe(false);
      expect(generated()).toBe(1);
      expect(await rows(second.id)).toEqual({});
      expect(await redis.get(LOCK)).toBe("another-rebuild");
    });
  });

  describe("a rebuild that loses its lock on its last match", () => {
    const LOCK = "elo-recompute:lock";
    const DEFERRED = "elo-recompute:deferred-ratings";
    const takeOver = (statusKey: string, deferred: string) => async () => {
      await redis.set(LOCK, "another-rebuild");
      await redis.sadd(DEFERRED, deferred);
      await redis.set(statusKey, JSON.stringify({ owner: "another-rebuild" }));
    };

    it("leaves a full rebuild's successor its deferred ratings and status", async () => {
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 2 });
      const last = await duel(a, b, { endedDaysAgo: 1 });
      await controller().recomputePlayerElo();
      const held = job(queued.shift()!.data);
      duringRun = {
        matchId: last.id,
        then: takeOver("elo-recompute:status", first.id),
      };

      await expect(
        new RecomputeAllElo(recompute).process(held as any),
      ).rejects.toBeInstanceOf(DelayedError);

      expect(await redis.smembers(DEFERRED)).toEqual([first.id]);
      expect(JSON.parse((await redis.get("elo-recompute:status"))!)).toEqual({
        owner: "another-rebuild",
      });
      expect(await redis.get("elo-recompute:covered")).toBeNull();
      expect(notifications.send).not.toHaveBeenCalled();
    });

    it("leaves a season rebuild's successor its deferred ratings, status and season", async () => {
      await fx.enableSeasons();
      const season = await fx.season("2025-01-01", null);
      const [a, b] = await fx.players(2);
      const first = await duel(a, b, { endedDaysAgo: 2 });
      const last = await duel(a, b, { endedDaysAgo: 1 });
      await postgres.query(
        "UPDATE seasons SET needs_rebuild = true WHERE id = $1",
        [season],
      );
      const sent: Array<string> = [];
      duringRun = {
        matchId: last.id,
        then: takeOver("season-elo-backfill:status", first.id),
      };

      expect(await backfill(sent).runBackfill(season)).toBe(false);

      expect(await redis.smembers(DEFERRED)).toEqual([first.id]);
      expect(
        JSON.parse((await redis.get("season-elo-backfill:status"))!),
      ).toEqual({ owner: "another-rebuild" });
      expect(
        sent.some((sql) => sql.includes("rebuild_player_season_stats")),
      ).toBe(false);
      const [row] = await postgres.query<Array<{ needs_rebuild: boolean }>>(
        "SELECT needs_rebuild FROM seasons WHERE id = $1",
        [season],
      );
      expect(row.needs_rebuild).toBe(true);
    });
  });

  describe("a rebuild that blocks", () => {
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    it.each([
      ["full", "elo-recompute:status"],
      ["season", "season-elo-backfill:status"],
    ])(
      "keeps a %s rebuild's status and event suppression alive on the lock's clock",
      async (kind, statusKey) => {
        timings.LOCK_RENEW_MS = 50;
        await fx.enableSeasons();
        const season = await fx.season("2025-01-01", null);
        const [a, b] = await fx.players(2);
        const match = await duel(a, b);
        const alive: Array<number> = [];
        duringRun = {
          matchId: match.id,
          then: async () => {
            await redis.del(statusKey, "elo-recompute:suppress-events");
            await pause(400);
            alive.push(
              await redis.exists(statusKey, "elo-recompute:suppress-events"),
            );
          },
        };

        if (kind === "full") {
          await controller().recomputePlayerElo();
          await work();
        } else {
          expect(await backfill().runBackfill(season)).toBe(true);
        }

        expect(alive).toEqual([2]);
      },
    );

    it("gives up on a TRUNCATE stuck behind a reader and retries", async () => {
      timings.TRUNCATE_LOCK_TIMEOUT_MS = 200;
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      await controller().recomputePlayerElo();
      const held = job(queued.shift()!.data);

      let finishReading!: () => void;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => (reading = resolve));
      const reader = postgres.transaction(async (client) => {
        await client.query("SELECT count(*) FROM player_elo");
        reading();
        await new Promise<void>((resolve) => {
          finishReading = resolve;
          setTimeout(resolve, 3000);
        });
      });
      await started;

      await expect(
        new RecomputeAllElo(recompute).process(held as any),
      ).rejects.toBeInstanceOf(DelayedError);

      finishReading();
      await reader;
      await new RecomputeAllElo(recompute).process(held as any);
      expect(Object.keys(await rows(match.id))).toHaveLength(2);
    });

    it("has Postgres cancel a rating that runs past its timeout", async () => {
      timings.ITEM_TIMEOUT_MS = 300;
      const [a, b] = await fx.players(2);
      await duel(a, b, { endedDaysAgo: 2 });
      const stuck = await duel(a, b, { endedDaysAgo: 1 });
      await controller().recomputePlayerElo();

      let rollBack!: () => void;
      let blocker: Promise<unknown> | undefined;
      duringRun = {
        matchId: stuck.id,
        then: async () => {
          let inserted!: () => void;
          const ready = new Promise<void>((resolve) => (inserted = resolve));
          blocker = postgres
            .transaction(async (client) => {
              await client.query(
                `INSERT INTO player_elo (steam_id, match_id, "type", current, change)
                 VALUES ($1, $2, 'Duel', 5000, 0)`,
                [a, stuck.id],
              );
              inserted();
              await new Promise<void>((resolve) => {
                rollBack = resolve;
                setTimeout(resolve, 3000);
              });
              throw new Error("roll back");
            })
            .catch((): void => undefined);
          await ready;
        },
      };
      await work();

      expect((await recompute.getStatus()).failed).toBe(1);
      const [{ count }] = await postgres.query<Array<{ count: string }>>(
        `SELECT count(*) FROM pg_stat_activity
          WHERE state = 'active'
            AND query LIKE '%generate_player_elo_for_match%'
            AND pid <> pg_backend_pid()`,
      );
      expect(Number(count)).toBe(0);

      rollBack();
      await blocker;
    });
  });

  describe("rebuild order", () => {
    // Created first, finished last: a match scheduled ahead of one that was
    // played sooner.
    const createdFirstFinishedLast = async (a: string, b: string) => {
      const late = await duel(a, b, { winner: "b", endedDaysAgo: 1 });
      const early = await duel(a, b, { endedDaysAgo: 2 });
      return { early, late };
    };

    const expectChained = async (
      early: string,
      late: string,
      players: Array<string>,
    ) => {
      const before = await rows(early);
      const after = await rows(late);
      for (const player of players) {
        expect(after[player].current - after[player].change).toBe(
          before[player].current,
        );
      }
    };

    it("rates the match that finished first first in a full rebuild", async () => {
      const [a, b] = await fx.players(2);
      const { early, late } = await createdFirstFinishedLast(a, b);

      await controller().recomputePlayerElo();
      await work();

      await expectChained(early.id, late.id, [a, b]);
    });

    it("rates the match that finished first first in a season rebuild", async () => {
      await fx.enableSeasons();
      const season = await fx.season("2025-01-01", null);
      const [a, b] = await fx.players(2);
      const { early, late } = await createdFirstFinishedLast(a, b);

      expect(await backfill().runBackfill(season)).toBe(true);

      await expectChained(early.id, late.id, [a, b]);
    });

    const FORMULA = "player_elo_backfill_series_multiplier_v1";
    const formulaMarker = async () =>
      (
        await postgres.query<Array<{ value: string }>>(
          "SELECT value FROM settings WHERE name = $1",
          [FORMULA],
        )
      )[0]?.value;

    it("asks for the rebuild a rating formula change needs until a run covering it finishes", async () => {
      await postgres.query("DELETE FROM settings WHERE name = $1", [FORMULA]);

      await recompute.recomputeOnce(FORMULA);
      await recompute.recomputeOnce(FORMULA);
      expect(queued).toHaveLength(2);
      expect(await formulaMarker()).toMatch(/^elo-recompute-pending:\d+$/);

      await work();
      expect(runs).toBe(1);
      expect(await formulaMarker()).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      await recompute.recomputeOnce(FORMULA);
      expect(queued).toHaveLength(0);
    });

    it("keeps that rebuild asked for, and tells nobody it finished, when its run fails", async () => {
      await postgres.query("DELETE FROM settings WHERE name = $1", [FORMULA]);
      const [a, b] = await fx.players(2);
      await duel(a, b);

      await recompute.recomputeOnce(FORMULA);
      const held = job(queued.shift()!.data);
      failOn = (sql) =>
        sql.includes("winning_lineup_id IS NOT NULL") &&
        sql.includes("ORDER BY ended_at");

      await expect(
        new RecomputeAllElo(recompute).process(held as any),
      ).rejects.toThrow("query failed");
      expect(notifications.send).not.toHaveBeenCalled();
      expect(await formulaMarker()).toMatch(/^elo-recompute-pending:\d+$/);
      expect((await recompute.getStatus()).running).toBe(false);

      failOn = undefined;
      await new RecomputeAllElo(recompute).process(held as any);
      expect(notifications.send).toHaveBeenCalledTimes(1);
      expect(await formulaMarker()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("who sees it", () => {
    const grants = (role: string) =>
      new HasuraPermissions(postgres).granted("matches", role);

    it.each(["guest", "user", "verified_user", "streamer"])(
      "shows a %s whether a match's ELO was voided, not who voided it or when",
      (role) => {
        expect(grants(role)).toContain("elo_voided");
        expect(grants(role)).not.toContain("elo_voided_at");
        expect(grants(role)).not.toContain("elo_voided_by_steam_id");
      },
    );

    it.each([
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ])("shows a %s who voided a match's ELO and when", (role) => {
      expect(grants(role)).toEqual(
        expect.arrayContaining([
          "elo_voided",
          "elo_voided_at",
          "elo_voided_by_steam_id",
        ]),
      );
    });
  });
});
