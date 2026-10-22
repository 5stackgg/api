jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

import { readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { DelayedError, Job } from "bullmq";
import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from "@nestjs/bullmq/dist/bull.constants";
import {
  getQueuesProcessors,
  RESUMABLE_JOB_MAX_STALLS,
} from "../utilities/QueueProcessors";
import { MatchQueues } from "./enums/MatchQueues";
import { RecomputeAllElo } from "./jobs/RecomputeAllElo";
import { PlayerEloRecomputeService } from "./player-elo-recompute.service";

const METADATA = join(__dirname, "../../hasura/metadata");

type Permission = { role: string; permission: { columns?: Array<string> } };

const matches = () =>
  yaml.load(
    readFileSync(
      join(METADATA, "databases/default/tables/public_matches.yaml"),
      "utf8",
    ),
  ) as {
    object_relationships: Array<{
      name: string;
      using: { foreign_key_constraint_on?: string };
    }>;
    insert_permissions: Array<Permission>;
    update_permissions: Array<Permission>;
  };

describe.each(["voidMatchElo", "restoreMatchElo"])("%s metadata", (name) => {
  it("is an administrator-only action", () => {
    const { actions } = yaml.load(
      readFileSync(join(METADATA, "actions.yaml"), "utf8"),
    ) as {
      actions: Array<{
        name: string;
        definition: { kind: string };
        permissions?: Array<{ role: string }>;
      }>;
    };

    const action = actions.find((candidate) => candidate.name === name);

    expect(action?.definition.kind).toBe("synchronous");
    expect(action?.permissions).toEqual([{ role: "administrator" }]);
  });

  it("takes the match and answers with success", () => {
    expect(readFileSync(join(METADATA, "actions.graphql"), "utf8")).toMatch(
      new RegExp(`${name}\\(\\s*match_id: uuid!\\s*\\): SuccessOutput\\n`),
    );
  });
});

describe("the void columns", () => {
  // Hasura exposes a relationship to every role that can read the remote
  // table, whatever the role may read of the join column, so a relationship to
  // the voiding player would show guests who voided a match.
  it("have no relationship to the player who voided the match", () => {
    expect(
      matches().object_relationships.filter(
        ({ name, using }) =>
          name.startsWith("elo_voided") ||
          using.foreign_key_constraint_on?.startsWith("elo_voided"),
      ),
    ).toEqual([]);
  });

  it("leave no role able to write them directly", () => {
    const { insert_permissions, update_permissions } = matches();

    for (const { permission } of [
      ...insert_permissions,
      ...update_permissions,
    ]) {
      expect(
        (permission.columns ?? []).filter((column) =>
          column.startsWith("elo_voided"),
        ),
      ).toEqual([]);
    }
  });
});

describe("RecomputeAllElo", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("hands the job's request to the recompute", async () => {
    const recompute = { runRecomputeAll: jest.fn().mockResolvedValue(true) };
    const job = { data: { request: 7 }, moveToDelayed: jest.fn() };

    await expect(
      new RecomputeAllElo(recompute as any).process(job as any),
    ).resolves.toBeUndefined();

    expect(recompute.runRecomputeAll).toHaveBeenCalledWith(7);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("re-delays the job while another run holds the lock", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    const recompute = { runRecomputeAll: jest.fn().mockResolvedValue(false) };
    const job = {
      data: { request: 7 },
      token: "token-1",
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      new RecomputeAllElo(recompute as any).process(job as any),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      1000 + PlayerEloRecomputeService.RETRY_DELAY_MS,
      "token-1",
    );
  });

  it("rides out api restarts mid-run", () => {
    const processor = getQueuesProcessors("Matches").find(
      (candidate) =>
        Reflect.getMetadata(PROCESSOR_METADATA, candidate)?.name ===
        MatchQueues.EloRecompute,
    );

    expect(Reflect.getMetadata(WORKER_METADATA, processor)).toMatchObject({
      concurrency: 1,
      maxStalledCount: RESUMABLE_JOB_MAX_STALLS,
    });
  });

  // BullMQ refuses a custom job id holding a ":" unless it splits into exactly
  // three parts, and a mocked queue never runs that check.
  it("uses job ids BullMQ accepts", () => {
    expect(() =>
      (
        Job.prototype as unknown as {
          validateOptions(this: object, json: { data: string }): void;
        }
      ).validateOptions.call(
        {
          name: RecomputeAllElo.name,
          opts: { jobId: PlayerEloRecomputeService.jobId(12) },
        },
        { data: "{}" },
      ),
    ).not.toThrow();
  });
});

describe("the rebuild lease", () => {
  let cache: {
    acquireLock: jest.Mock;
    refreshLock: jest.Mock;
    releaseLock: jest.Mock;
  };
  let service: PlayerEloRecomputeService;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = {
      acquireLock: jest.fn().mockResolvedValue("token"),
      refreshLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    service = new PlayerEloRecomputeService(
      { log: jest.fn(), warn: jest.fn() } as any,
      {} as any,
      cache as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renews the lock on a clock, whatever the run is doing", async () => {
    const lease = (await service.acquireRebuildLease())!;

    await jest.advanceTimersByTimeAsync(
      PlayerEloRecomputeService.LOCK_RENEW_MS,
    );
    expect(cache.refreshLock).toHaveBeenCalledTimes(1);
    expect(cache.refreshLock).toHaveBeenCalledWith(
      "elo-recompute:lock",
      "token",
      expect.any(Number),
    );
    expect(PlayerEloRecomputeService.LOCK_RENEW_MS * 3).toBeLessThan(
      cache.refreshLock.mock.calls[0][2] * 1000,
    );

    await lease.release();
    await jest.advanceTimersByTimeAsync(
      PlayerEloRecomputeService.LOCK_RENEW_MS * 5,
    );
    expect(cache.refreshLock).toHaveBeenCalledTimes(1);
    expect(cache.releaseLock).toHaveBeenCalledWith(
      "elo-recompute:lock",
      "token",
    );
  });

  it("treats a renewal that finds the lock gone as final", async () => {
    const lease = (await service.acquireRebuildLease())!;
    cache.refreshLock.mockResolvedValueOnce(false);

    await jest.advanceTimersByTimeAsync(
      PlayerEloRecomputeService.LOCK_RENEW_MS,
    );

    await expect(lease.renew()).resolves.toBe(false);
    expect(cache.refreshLock).toHaveBeenCalledTimes(1);
    await lease.release();
  });
});
