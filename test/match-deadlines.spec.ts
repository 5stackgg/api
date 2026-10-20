import { Logger } from "@nestjs/common";
import { PostgresService } from "./../src/postgres/postgres.service";
import { DeadlinesService } from "../src/matches/deadlines/deadlines.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// The reconcile pass is what recovers a deadline whose wake-up was never armed
// or was lost with Redis, so its queries have to find exactly the rows that
// fall due before the next pass.
describe("deadline reconcile (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let queue: { add: jest.Mock };
  let vetoQueue: { add: jest.Mock; getDelayed: jest.Mock };
  let deadlines: DeadlinesService;

  beforeAll(async () => {
    db = await bootMigratedDb("MatchDeadlinesTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA", 27015);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM tournaments");
    await postgres.query("DELETE FROM matches");
    queue = { add: jest.fn() };
    vetoQueue = { add: jest.fn(), getDelayed: jest.fn().mockResolvedValue([]) };
    deadlines = new DeadlinesService(
      new Logger("MatchDeadlinesTest"),
      postgres,
      queue as any,
      vetoQueue as any,
    );
  });

  // Wake-ups set for later, leaving out the run-everything-now part of the
  // pass, as the job each wakes and the second it is for.
  const armed = (target: { add: jest.Mock } = queue) =>
    target.add.mock.calls
      .filter(([, , opts]) => opts.delay > 5_000)
      .map(([name, , opts]) => [name, opts.jobId])
      .sort();

  const second = (at: Date, offsetMs = 0) =>
    Math.floor((at.getTime() + offsetMs + 1000) / 1000);

  const openTournament = async (startsIn: string) => {
    const [options] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO match_options (mr, best_of, type, map_pool_id, map_veto, region_veto, regions)
       SELECT 8, 1, 'Wingman', id, false, true, '{TestA}'
       FROM map_pools WHERE type = 'Wingman' AND seed = true RETURNING id`,
    );
    const [tournament] = await postgres.query<Array<{ start: Date }>>(
      `INSERT INTO tournaments (name, start, organizer_steam_id, match_options_id, status)
       VALUES ($1, now() + $2::interval, $3, $4, 'RegistrationOpen') RETURNING start`,
      [fx.nextName("cup"), startsIn, await fx.player(), options.id],
    );
    return tournament;
  };

  const setCancelsAt = async (matchId: string, interval: string) => {
    const [row] = await postgres.query<Array<{ cancels_at: Date }>>(
      `UPDATE matches SET cancels_at = now() + $2::interval WHERE id = $1 RETURNING cancels_at`,
      [matchId, interval],
    );
    return row.cancels_at;
  };

  it("runs every sweep straight away", async () => {
    await deadlines.reconcile();

    const now = queue.add.mock.calls
      .filter(([, , opts]) => opts.delay <= 5_000)
      .map(([name]) => name)
      .sort();
    expect(now).toEqual([...DeadlinesService.SWEEPS].sort());
    expect(vetoQueue.add).toHaveBeenCalledWith(
      "AutoPickExpiredVeto",
      {},
      expect.anything(),
    );
  });

  it("arms a match that expires before the next pass, and not one that expires later", async () => {
    const soon = await fx.match();
    const later = await fx.match();
    const soonAt = await setCancelsAt(soon.id, "5 minutes");
    await setCancelsAt(later.id, "30 minutes");

    await deadlines.reconcile();

    expect(armed()).toEqual(
      [
        ["CancelExpiredMatches", `CancelExpiredMatches.at.${second(soonAt)}`],
        [
          "CancelExpiredMatches",
          `CancelExpiredMatches.at.${second(soonAt, -60_000)}`,
        ],
      ].sort(),
    );
  });

  it("arms a scheduled match whose check-in opens before the next pass", async () => {
    const match = await fx.match({ type: "Duel" });
    await fx.lineupPlayer(match.lineup_1_id);
    await fx.lineupPlayer(match.lineup_2_id);
    const [row] = await postgres.query<Array<{ scheduled_at: Date }>>(
      `UPDATE matches SET status = 'Scheduled', scheduled_at = now() + interval '20 minutes'
        WHERE id = $1 RETURNING scheduled_at`,
      [match.id],
    );

    await deadlines.reconcile();

    expect(armed()).toContainEqual([
      "CheckForScheduledMatches",
      `CheckForScheduledMatches.at.${second(row.scheduled_at, -15 * 60_000)}`,
    ]);
  });

  it("arms a tournament about to start and leaves one starting tomorrow", async () => {
    const row = await openTournament("20 minutes");
    await openTournament("1 day");

    await deadlines.reconcile();

    expect(armed()).toContainEqual([
      "CheckForTournamentStart",
      `CheckForTournamentStart.at.${second(row.start, -15 * 60_000)}`,
    ]);
    expect(armed()).toContainEqual([
      "CancelInvalidTournaments",
      `CancelInvalidTournaments.at.${second(row.start)}`,
    ]);
    expect(
      armed().filter(([name]) => name === "CheckForTournamentStart"),
    ).toEqual(
      [
        [
          "CheckForTournamentStart",
          `CheckForTournamentStart.at.${second(row.start, -15 * 60_000)}`,
        ],
        [
          "CheckForTournamentStart",
          `CheckForTournamentStart.at.${second(row.start)}`,
        ],
      ].sort(),
    );
  });

  it("wakes the veto sweep for a turn that runs out before the next pass", async () => {
    const { poolId } = await fx.mapPool(3);
    const match = await fx.match({
      mapVeto: true,
      mapPoolId: poolId,
      vetoPickTimeout: 45,
    });
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);
    const [row] = await postgres.query<
      Array<{ status: string; veto_pick_expires_at: Date }>
    >("SELECT status, veto_pick_expires_at FROM matches WHERE id = $1", [
      match.id,
    ]);
    expect(row.status).toBe("Veto");

    await deadlines.reconcile();

    expect(armed(vetoQueue)).toEqual([
      [
        "AutoPickExpiredVeto",
        `AutoPickExpiredVeto.at.${second(row.veto_pick_expires_at)}`,
      ],
    ]);
  });
});
