import { Logger } from "@nestjs/common";
import { DelayedError } from "bullmq";
import IORedis, { Redis } from "ioredis";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { User } from "./../src/auth/types/User";
import { CacheService } from "./../src/cache/cache.service";
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

// An administrator voiding a played match's ELO: the real rating engine, the
// real full recompute and season rebuild, and a real redis behind the
// recompute's request bookkeeping. The BullMQ queue is the only stand-in.
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

    cache = new CacheService({ getConnection: () => redis } as any, logger);
    queued = [];
    runs = 0;
    duringRun = undefined;
    queue = {
      add: jest.fn(async (name, data, opts) => {
        queued.push({ name, data, opts });
      }),
    };

    // Counts full runs, and lets a test land a write in the middle of one,
    // right before the run rebuilds a given match.
    const watched = {
      query: async (
        sql: string,
        params?: Parameters<PostgresService["query"]>[1],
      ) => {
        if (sql.includes("TRUNCATE TABLE player_elo")) {
          runs += 1;
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
        return postgres.query(sql, params);
      },
    } as unknown as PostgresService;

    recompute = new PlayerEloRecomputeService(
      logger,
      watched,
      cache,
      { send: jest.fn() } as any,
      { add: jest.fn() } as any,
    );

    admin = await fx.player(undefined, "administrator");
  });

  const controller = () =>
    Object.assign(Object.create(MatchesController.prototype), {
      logger,
      postgres,
      playerEloRecompute: recompute,
      eloRecomputeQueue: queue,
    }) as MatchesController;

  const voidElo = (matchId: string, steamId = admin, role = "administrator") =>
    controller().voidMatchElo({
      match_id: matchId,
      user: { steam_id: steamId, role, name: "admin" } as User,
    });

  // What the RecomputeAllElo worker does with each queued job, in order.
  const work = async () => {
    while (queued.length > 0) {
      const { data } = queued.shift()!;
      await new RecomputeAllElo(recompute).process({
        data,
        token: "token",
        moveToDelayed: jest.fn(),
      } as any);
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

      const [profile] = await postgres.query<
        Array<{ elo: Record<string, number | null> }>
      >("SELECT get_player_elo(p) AS elo FROM players p WHERE steam_id = $1", [
        teamA[0],
      ]);
      expect(Number(profile.elo.rush)).toBe(5000);
    });

    it("leaves a match that was never rated unrated", async () => {
      const [a, b] = await fx.players(2);

      const imported = await duel(a, b);
      await postgres.query(
        "UPDATE matches SET source = 'faceit' WHERE id = $1",
        [imported.id],
      );

      const unranked = await duel(a, b);
      await postgres.query(
        "UPDATE matches SET counts_toward_ranking = false WHERE id = $1",
        [unranked.id],
      );

      const tie = await duel(a, b);
      await postgres.query(
        "UPDATE matches SET winning_lineup_id = NULL, status = 'Tie' WHERE id = $1",
        [tie.id],
      );

      for (const match of [imported, unranked, tie]) {
        await voidElo(match.id);
        expect(await generate(match.id)).toBe(0);
        expect(Object.keys(await rows(match.id))).toHaveLength(0);
      }
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

      const backfill = new SeasonEloBackfillService(
        logger,
        postgres,
        cache,
        { send: jest.fn() } as any,
        recompute,
        { add: jest.fn() } as any,
      );
      expect(await backfill.runBackfill(season)).toBe(true);

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
    it("voids a tournament match on the tournament track and leaves its result, bracket and MVP standing alone", async () => {
      await fx.enableSeasons();
      await fx.season("2025-01-01", null);
      const t = await tfx.launch(
        [{ type: "SingleElimination", order: 1, minTeams: 4, maxTeams: 8 }],
        4,
      );
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
  });

  describe("voidMatchElo", () => {
    it.each([
      "user",
      "verified_user",
      "streamer",
      "moderator",
      "match_organizer",
      "tournament_organizer",
    ])("refuses a %s even when called directly", async (role) => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      const caller = await fx.player(undefined, role);

      await expect(voidElo(match.id, caller, role)).rejects.toThrow(
        "you must be an administrator",
      );

      expect((await voidState(match.id)).elo_voided).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each(["Finished", "Forfeit", "Tie", "Surrendered"])(
      "voids a %s match, recording who voided it and when",
      async (status) => {
        const [a, b] = await fx.players(2);
        const match = await duel(a, b);
        await postgres.query(
          `UPDATE matches SET status = $2,
             winning_lineup_id = CASE WHEN $2 = 'Tie' THEN NULL ELSE winning_lineup_id END
           WHERE id = $1`,
          [match.id, status],
        );

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

    it("refuses a match that does not exist", async () => {
      await expect(
        voidElo("00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow("match not found");
    });

    it("succeeds again without asking for another recompute", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);

      await voidElo(match.id);
      const first = await voidState(match.id);
      const other = await fx.player(undefined, "administrator");
      await expect(voidElo(match.id, other)).resolves.toEqual({
        success: true,
      });

      expect(await voidState(match.id)).toEqual(first);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it("lets exactly one of two simultaneous voids through", async () => {
      const [a, b] = await fx.players(2);
      const match = await duel(a, b);
      const other = await fx.player(undefined, "administrator");

      await expect(
        Promise.all([voidElo(match.id), voidElo(match.id, other)]),
      ).resolves.toEqual([{ success: true }, { success: true }]);

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect([admin, other]).toContain(
        (await voidState(match.id)).elo_voided_by_steam_id,
      );
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
      const job = {
        data: queued[0].data,
        token: "token",
        moveToDelayed: jest.fn(),
      };
      await expect(
        new RecomputeAllElo(recompute).process(job as any),
      ).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(
        expect.any(Number),
        "token",
      );
      expect(runs).toBe(0);

      await cache.releaseLock("elo-recompute:lock", holder!);
      await new RecomputeAllElo(recompute).process(job as any);

      expect(runs).toBe(1);
      expect((await rows(match.id))[a].change).toBe(0);
    });
  });

  describe("who sees it", () => {
    it.each([
      "guest",
      "user",
      "verified_user",
      "streamer",
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "administrator",
    ])(
      "lets a %s read whether a match's ELO was voided, when and by whom",
      (role) => {
        expect(
          new HasuraPermissions(postgres).granted("matches", role),
        ).toEqual(
          expect.arrayContaining([
            "elo_voided",
            "elo_voided_at",
            "elo_voided_by_steam_id",
          ]),
        );
      },
    );
  });
});
