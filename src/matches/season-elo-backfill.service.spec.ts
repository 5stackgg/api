jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));
jest.mock("./player-elo-recompute.service", () => ({
  PlayerEloRecomputeService: class PlayerEloRecomputeService {},
}));

import { DelayedError } from "bullmq";
import { SeasonEloBackfillService } from "./season-elo-backfill.service";
import { BackfillSeasonElo } from "./jobs/BackfillSeasonElo";

const WINDOW = {
  starts_at: "2025-11-08 00:00:00.123456+00",
  ends_at: null,
};

describe("SeasonEloBackfillService.runBackfill", () => {
  let postgres: { query: jest.Mock };
  let cache: {
    get: jest.Mock;
    put: jest.Mock;
    forget: jest.Mock;
    acquireLock: jest.Mock;
    refreshLock: jest.Mock;
  };
  let service: SeasonEloBackfillService;
  let clearedRows: Array<{ id: string }>;

  beforeEach(() => {
    clearedRows = [{ id: "season-1" }];
    postgres = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("FROM seasons WHERE id")) {
          return [WINDOW];
        }
        if (sql.includes("UPDATE seasons SET needs_rebuild")) {
          return clearedRows;
        }
        if (sql.includes("FROM matches m")) {
          return [{ id: "match-1" }];
        }
        return [];
      }),
    };
    cache = {
      get: jest.fn().mockResolvedValue(undefined),
      put: jest.fn().mockResolvedValue(true),
      forget: jest.fn().mockResolvedValue(true),
      acquireLock: jest.fn().mockResolvedValue(true),
      refreshLock: jest.fn().mockResolvedValue(undefined),
    };
    service = new SeasonEloBackfillService(
      { log: jest.fn(), warn: jest.fn() } as any,
      postgres as any,
      cache as any,
      { send: jest.fn() } as any,
      { setSuppressEvents: jest.fn() } as any,
      { add: jest.fn() } as any,
    );
  });

  it("finishes when the rebuilt window is still the season's window", async () => {
    await expect(service.runBackfill("season-1")).resolves.toBe(true);

    const clear = postgres.query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE seasons SET needs_rebuild"),
    );
    expect(clear?.[1]).toEqual([
      "season-1",
      WINDOW.starts_at,
      WINDOW.ends_at,
    ]);
    expect(cache.forget).toHaveBeenCalledWith("season-elo-backfill:lock");
  });

  it("asks for a retry when the dates moved mid-run", async () => {
    clearedRows = [];

    await expect(service.runBackfill("season-1")).resolves.toBe(false);
  });

  it("asks for a retry instead of dropping the run when the lock is held", async () => {
    cache.acquireLock.mockResolvedValue(false);

    await expect(service.runBackfill("season-1")).resolves.toBe(false);
    expect(
      postgres.query.mock.calls.some(([sql]) =>
        sql.includes("DELETE FROM player_elo"),
      ),
    ).toBe(false);
  });

  it("settles the queued status of a deleted season without taking the lock", async () => {
    postgres.query.mockResolvedValue([]);
    cache.get.mockResolvedValue({
      running: true,
      canceled: false,
      started_at: "2026-09-28T20:07:03.000Z",
      finished_at: null,
      season_id: "season-1",
      total: 0,
      completed: 0,
      failed: 0,
      current_match_id: null,
    });

    await expect(service.runBackfill("season-1")).resolves.toBe(true);

    expect(cache.acquireLock).not.toHaveBeenCalled();
    expect(cache.put).toHaveBeenCalledWith(
      "season-elo-backfill:status",
      expect.objectContaining({ running: false, season_id: "season-1" }),
      expect.any(Number),
    );
  });
});

describe("BackfillSeasonElo", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("re-delays the job when the backfill asks for a retry", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    const backfill = { runBackfill: jest.fn().mockResolvedValue(false) };
    const job = {
      data: { season_id: "season-1" },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
      token: "token-1",
    };

    await expect(
      new BackfillSeasonElo(backfill as any).process(job as any),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      1000 + SeasonEloBackfillService.RETRY_DELAY_MS,
      "token-1",
    );
  });

  it("completes when the backfill finished", async () => {
    const backfill = { runBackfill: jest.fn().mockResolvedValue(true) };
    const job = { data: { season_id: "season-1" }, moveToDelayed: jest.fn() };

    await expect(
      new BackfillSeasonElo(backfill as any).process(job as any),
    ).resolves.toBeUndefined();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
