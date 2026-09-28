import { ReconcilePendingMatchImports } from "./ReconcilePendingMatchImports";

type FakeJob = { state: string; failedReason?: string };

const build = (
  stale: string[],
  jobs: Record<string, FakeJob | undefined> = {},
) => {
  const updates: unknown[][] = [];
  const postgres = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT valve_match_id")) {
        return stale.map((valve_match_id) => ({ valve_match_id }));
      }
      if (sql.includes("SET status = 'Failed'")) {
        updates.push(params);
        return [{ valve_match_id: params[0] }];
      }
      return [];
    }),
  };
  const queue = {
    getJob: jest.fn(async (id: string) => {
      const job = jobs[id];
      return job
        ? { failedReason: job.failedReason, getState: async () => job.state }
        : undefined;
    }),
  };
  const logger = { warn: jest.fn() };

  const reconcile = new ReconcilePendingMatchImports(
    logger as never,
    postgres as never,
    queue as never,
    queue as never,
  );

  return { reconcile, updates };
};

describe("ReconcilePendingMatchImports", () => {
  it("fails a stranded row whose jobs are gone", async () => {
    const { reconcile, updates } = build(["111"]);

    await reconcile.process();

    expect(updates).toEqual([
      ["111", "import job ended without finishing the import", "15 minutes"],
    ]);
  });

  it("carries the failed job's reason onto the row", async () => {
    const { reconcile, updates } = build(["222"], {
      "resolve-222": {
        state: "failed",
        failedReason: 'column "parties" does not exist',
      },
    });

    await reconcile.process();

    expect(updates[0]?.[1]).toBe('column "parties" does not exist');
  });

  it("fails a row whose parse job stalled out after resolve completed", async () => {
    const { reconcile, updates } = build(["333"], {
      "resolve-333": { state: "completed" },
      "parse-333": {
        state: "failed",
        failedReason: "job stalled more than allowable limit",
      },
    });

    await reconcile.process();

    expect(updates[0]?.[1]).toBe("job stalled more than allowable limit");
  });

  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children"])(
    "leaves a row alone while a job is %s",
    async (state) => {
      const { reconcile, updates } = build(["444"], {
        "resolve-444": { state: "completed" },
        "parse-444": { state },
      });

      await reconcile.process();

      expect(updates).toHaveLength(0);
    },
  );
});
