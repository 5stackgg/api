import { CleanDemos } from "./CleanDemos";

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const PAGE_READ_CAP = 100;

type Row = {
  id: string;
  size: number | null;
  playback_size: number | null;
  ended_at: string;
};

const row = (
  id: string,
  size: number | null,
  daysAgo: number,
  playback_size: number | null = null,
): Row => ({
  id,
  size,
  playback_size,
  ended_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
});

const setup = (
  rows: Array<Row>,
  options: { maxGB?: number; failing?: Array<string> } = {},
) => {
  const table = [...rows];
  const pages: Array<Array<string>> = [];
  const failing = options.failing ?? [];

  const hasura = {
    query: jest.fn(async (query: any) => {
      if (query.settings) {
        return {
          settings: [
            { name: "s3_min_retention", value: "30" },
            { name: "s3_max_storage", value: String(options.maxGB ?? 100) },
          ],
        };
      }

      if (query.match_map_demos_aggregate) {
        return {
          match_map_demos_aggregate: {
            aggregate: {
              sum: {
                size: table.reduce(
                  (total, demo) => total + (demo.size ?? 0),
                  0,
                ),
                playback_size: table.reduce(
                  (total, demo) => total + (demo.playback_size ?? 0),
                  0,
                ),
              },
            },
          },
        };
      }

      if (pages.length >= PAGE_READ_CAP) {
        throw new Error(`read more than ${PAGE_READ_CAP} pages`);
      }

      const args = query.match_map_demos.__args;
      const before = args.where.match.ended_at._lt;
      const excluded: Array<string> = args.where.id?._nin ?? [];
      const tiesById = args.order_by.some((order: any) => order.id === "asc");
      const offset = args.offset ?? 0;

      const page = table
        .filter((demo) => {
          return demo.ended_at < before && !excluded.includes(demo.id);
        })
        .sort((a, b) => {
          return (
            a.ended_at.localeCompare(b.ended_at) ||
            (tiesById ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id))
          );
        })
        .slice(offset, offset + args.limit);

      pages.push(page.map((demo) => demo.id));

      return {
        match_map_demos: page.map(({ id, size, playback_size }) => ({
          id,
          size,
          playback_size,
          file: `demos/${id}.dem`,
        })),
      };
    }),
  };

  const demoMetadata = {
    deleteDemo: jest.fn(async (id: string) => {
      if (failing.includes(id)) {
        throw new Error("s3 unavailable");
      }
      const index = table.findIndex((demo) => demo.id === id);
      if (index === -1) {
        return;
      }
      table.splice(index, 1);
    }),
  };

  const logger = { log: jest.fn(), warn: jest.fn() };

  const job = new CleanDemos(demoMetadata as any, logger as any, hasura as any);

  const deleted = () => {
    return demoMetadata.deleteDemo.mock.calls.map(([id]) => id);
  };

  return { job, table, pages, demoMetadata, logger, deleted };
};

const oldDemos = (count: number, size: number) => {
  return Array.from({ length: count }, (_, i) => {
    return row(`old-${String(i).padStart(2, "0")}`, size, 100 - i);
  });
};

describe("CleanDemos", () => {
  it("does nothing under the storage limit", async () => {
    const { job, pages, deleted } = setup([
      row("a", 50 * GB, 60),
      row("b", 49 * GB, 40),
    ]);

    await expect(job.process()).resolves.toBe(0);
    expect(pages).toHaveLength(0);
    expect(deleted()).toEqual([]);
  });

  it("does nothing at exactly the storage limit", async () => {
    const { job, pages, deleted } = setup([
      row("a", 60 * GB, 60),
      row("b", 30 * GB, 40, 10 * GB),
    ]);

    await expect(job.process()).resolves.toBe(0);
    expect(pages).toHaveLength(0);
    expect(deleted()).toEqual([]);
  });

  it("deletes the oldest demos past retention until storage is at the limit", async () => {
    const { job, deleted, logger } = setup([
      row("recent", 97 * GB, 1),
      ...oldDemos(5, GB),
    ]);

    const marked = await job.process();

    expect(deleted()).toEqual(["old-00", "old-01"]);
    expect(marked).toBe(2);
    expect(logger.log).toHaveBeenCalledWith(
      "Deleted 2 demos, freeing up 2.00 GB",
    );
  });

  it("reads each demo in at most one page", async () => {
    const { job, pages, deleted } = setup([
      row("recent", 90 * GB, 1),
      ...oldDemos(25, GB),
    ]);

    await job.process();

    expect(pages[1]).not.toEqual(pages[0]);
    const read = pages.flat();
    expect(new Set(read).size).toBe(read.length);
    expect(pages).toHaveLength(2);
    expect(deleted()).toHaveLength(15);
  });

  it("stops when no demo is past retention", async () => {
    const { job, pages, deleted } = setup([row("recent", 150 * GB, 2)]);

    await expect(job.process()).resolves.toBe(0);
    expect(pages).toHaveLength(1);
    expect(deleted()).toEqual([]);
  });

  it("deletes every demo past retention and stops when that is not enough", async () => {
    const { job, table, deleted } = setup([
      row("recent", 150 * GB, 2),
      row("imported", null, 90),
      ...oldDemos(3, GB),
    ]);

    const marked = await job.process();

    expect([...deleted()].sort()).toEqual([
      "imported",
      "old-00",
      "old-01",
      "old-02",
    ]);
    expect(table.map((demo) => demo.id)).toEqual(["recent"]);
    expect(marked).toBe(4);
  });

  it("counts playback blobs toward storage and toward what a delete frees", async () => {
    const { job, deleted } = setup([
      row("recent", 97 * GB, 1, 1.5 * GB),
      row("a", GB, 90, GB),
      row("b", GB, 80),
    ]);

    const marked = await job.process();

    expect(deleted()).toEqual(["a"]);
    expect(marked).toBe(1);
  });

  it("deletes demos that ended at the same moment in id order", async () => {
    const sameEnd = new Date(Date.now() - 60 * DAY).toISOString();
    const { job, deleted } = setup([
      row("recent", 10 * GB, 1),
      ...Array.from({ length: 35 }, (_, i) => ({
        ...row(`tie-${String(i).padStart(2, "0")}`, 3 * GB, 60),
        ended_at: sameEnd,
      })),
    ]);

    const marked = await job.process();

    expect(deleted()).toEqual([
      "tie-00",
      "tie-01",
      "tie-02",
      "tie-03",
      "tie-04",
    ]);
    expect(marked).toBe(5);
  });

  it("skips a demo whose delete fails without retrying it", async () => {
    const { job, table, pages, deleted, logger } = setup(
      [row("recent", 97.5 * GB, 1), ...oldDemos(4, GB)],
      { failing: ["old-00"] },
    );

    await expect(job.process()).resolves.toBe(2);
    expect(deleted()).toEqual(["old-00", "old-01", "old-02"]);
    expect(table.map((demo) => demo.id)).toContain("old-00");
    expect(pages.flat().filter((id) => id === "old-00")).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("old-00"));
  });

  it("stops when every delete fails", async () => {
    const { job, deleted } = setup(
      [row("recent", 150 * GB, 1), ...oldDemos(12, GB)],
      { failing: oldDemos(12, GB).map((demo) => demo.id) },
    );

    await expect(job.process()).resolves.toBe(0);
    expect(deleted()).toHaveLength(12);
  });
});
