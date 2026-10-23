import { CleanDemos } from "./CleanDemos";
import { DemoMetadataService } from "../demo-metadata.service";

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const PAGE_READ_CAP = 100;

type Row = {
  id: string;
  size: number | null;
  playback_size: number | null;
  ended_at: string;
  file: string;
  playback_file: string | null;
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
  file: `demos/match/${id}.dem`,
  playback_file: playback_size ? `demos/match/${id}.playback.json.gz` : null,
});

const imported = (
  id: string,
  daysAgo: number,
  playback_size: number | null = null,
): Row => ({
  ...row(id, null, daysAgo, playback_size),
  file: `https://replay.valve.net/730/${id}.dem.bz2`,
});

const setup = (
  rows: Array<Row>,
  options: {
    maxGB?: number;
    s3Failing?: Array<string>;
    rowDeleteFailing?: Array<string>;
    rowDeleteIgnored?: Array<string>;
  } = {},
) => {
  const table = [...rows];
  const pages: Array<Array<string>> = [];
  const s3Failing = options.s3Failing ?? [];
  const rowDeleteFailing = options.rowDeleteFailing ?? [];
  const rowDeleteIgnored = options.rowDeleteIgnored ?? [];
  const objects = new Set(
    rows.flatMap((demo) => {
      return [
        ...(DemoMetadataService.isExternalDemoUrl(demo.file)
          ? []
          : [demo.file]),
        ...(demo.playback_file ? [demo.playback_file] : []),
      ];
    }),
  );

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const sweep = (prefix: string) => {
    const keys = [...objects].filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      objects.delete(key);
    }
    return keys.length;
  };

  const s3 = {
    removePrefix: jest.fn(async (prefix: string) => {
      if (s3Failing.includes(prefix)) {
        logger.warn(`unable to remove 1 object(s) under ${prefix}`);
        return 0;
      }
      return sweep(prefix);
    }),
    removePrefixStrictly: jest.fn(async (prefix: string) => {
      if (s3Failing.includes(prefix)) {
        throw new Error(
          `unable to remove 1 object(s) under ${prefix}: AccessDenied`,
        );
      }
      return sweep(prefix);
    }),
  };

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

      if (query.match_map_demos_by_pk) {
        const demo = table.find(({ id }) => {
          return id === query.match_map_demos_by_pk.__args.id;
        });

        return {
          match_map_demos_by_pk: demo
            ? {
                id: demo.id,
                match_id: "match",
                match_map_id: "match-map",
                file: demo.file,
                playback_file: demo.playback_file,
              }
            : null,
        };
      }

      if (pages.length >= PAGE_READ_CAP) {
        throw new Error(`read more than ${PAGE_READ_CAP} pages`);
      }

      const args = query.match_map_demos.__args;
      const before = args.where.match.ended_at._lt;
      const excluded: Array<string> = args.where.id?._nin ?? [];
      const holdsStorage = !!args.where._or;
      const tiesById = args.order_by.some((order: any) => order.id === "asc");
      const offset = args.offset ?? 0;

      const page = table
        .filter((demo) => {
          return (
            demo.ended_at < before &&
            !excluded.includes(demo.id) &&
            (!holdsStorage ||
              (demo.size ?? 0) > 0 ||
              (demo.playback_size ?? 0) > 0)
          );
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
        match_map_demos: page.map(({ id, size, playback_size, file }) => ({
          id,
          size,
          playback_size,
          file,
        })),
      };
    }),
    mutation: jest.fn(async (mutation: any) => {
      const id = mutation.delete_match_map_demos_by_pk.__args.id;

      if (rowDeleteFailing.includes(id)) {
        throw new Error("hasura unavailable");
      }

      const index = table.findIndex((demo) => demo.id === id);

      if (index !== -1 && !rowDeleteIgnored.includes(id)) {
        table.splice(index, 1);
      }

      return { delete_match_map_demos_by_pk: { __typename: "x" } };
    }),
  };

  const demoMetadata = new DemoMetadataService(
    logger as any,
    hasura as any,
    {} as any,
    s3 as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const deleteDemo = jest.spyOn(demoMetadata, "deleteDemo");

  const job = new CleanDemos(demoMetadata, logger as any, hasura as any);

  const attempted = () => {
    return deleteDemo.mock.calls.map(([id]) => id);
  };

  const remaining = () => {
    return table.map((demo) => demo.id);
  };

  return { job, objects, pages, logger, attempted, remaining };
};

const oldDemos = (count: number, size: number) => {
  return Array.from({ length: count }, (_, i) => {
    return row(`old-${String(i).padStart(2, "0")}`, size, 100 - i);
  });
};

describe("CleanDemos", () => {
  it("does nothing under the storage limit", async () => {
    const { job, pages, attempted } = setup([
      row("a", 50 * GB, 60),
      row("b", 49 * GB, 40),
    ]);

    await expect(job.process()).resolves.toBe(0);
    expect(pages).toHaveLength(0);
    expect(attempted()).toEqual([]);
  });

  it("does nothing at exactly the storage limit", async () => {
    const { job, pages, attempted } = setup([
      row("a", 60 * GB, 60),
      row("b", 30 * GB, 40, 10 * GB),
    ]);

    await expect(job.process()).resolves.toBe(0);
    expect(pages).toHaveLength(0);
    expect(attempted()).toEqual([]);
  });

  it("deletes the oldest demos past retention until storage is at the limit", async () => {
    const { job, objects, remaining, logger } = setup([
      row("recent", 97 * GB, 1),
      ...oldDemos(5, GB),
    ]);

    const deleted = await job.process();

    expect(remaining()).toEqual(["recent", "old-02", "old-03", "old-04"]);
    expect(objects.has("demos/match/old-00.dem")).toBe(false);
    expect(objects.has("demos/match/old-01.dem")).toBe(false);
    expect(deleted).toBe(2);
    expect(logger.log).toHaveBeenCalledWith(
      "[clean-demos] deleted demo old-00, freeing up 1.00 GB",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "[clean-demos] deleted demo old-01, freeing up 1.00 GB",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "Deleted 2 demos, freeing up 2.00 GB",
    );
  });

  it("reads each demo in at most one page", async () => {
    const { job, pages, attempted } = setup([
      row("recent", 90 * GB, 1),
      ...oldDemos(25, GB),
    ]);

    await job.process();

    expect(pages[1]).not.toEqual(pages[0]);
    const read = pages.flat();
    expect(new Set(read).size).toBe(read.length);
    expect(pages).toHaveLength(2);
    expect(attempted()).toHaveLength(15);
  });

  it("stops when no demo is past retention", async () => {
    const { job, pages, attempted } = setup([row("recent", 150 * GB, 2)]);

    await expect(job.process()).resolves.toBe(0);
    expect(pages).toHaveLength(1);
    expect(attempted()).toEqual([]);
  });

  it("deletes every demo past retention that holds storage, and stops when that is not enough", async () => {
    const { job, remaining, attempted } = setup([
      row("recent", 150 * GB, 2),
      imported("imported", 120),
      imported("imported-parsed", 110, GB),
      ...oldDemos(3, GB),
    ]);

    const deleted = await job.process();

    expect(attempted()).not.toContain("imported");
    expect(remaining()).toEqual(["recent", "imported"]);
    expect(deleted).toBe(4);
  });

  it("counts playback blobs toward storage and toward what a delete frees", async () => {
    const { job, objects, attempted } = setup([
      row("recent", 97 * GB, 1, 1.5 * GB),
      row("a", GB, 90, GB),
      row("b", GB, 80),
    ]);

    const deleted = await job.process();

    expect(attempted()).toEqual(["a"]);
    expect(objects.has("demos/match/a.playback.json.gz")).toBe(false);
    expect(deleted).toBe(1);
  });

  it("deletes demos that ended at the same moment in id order", async () => {
    const sameEnd = new Date(Date.now() - 60 * DAY).toISOString();
    const { job, attempted } = setup([
      row("recent", 10 * GB, 1),
      ...Array.from({ length: 35 }, (_, i) => ({
        ...row(`tie-${String(i).padStart(2, "0")}`, 3 * GB, 60),
        ended_at: sameEnd,
      })),
    ]);

    const deleted = await job.process();

    expect(attempted()).toEqual([
      "tie-00",
      "tie-01",
      "tie-02",
      "tie-03",
      "tie-04",
    ]);
    expect(deleted).toBe(5);
  });

  it.each([
    ["demo", "demos/match/old-00.dem"],
    ["playback blob", "demos/match/old-00.playback.json.gz"],
  ])(
    "keeps the row and stops when S3 cannot remove the %s",
    async (_, failing) => {
      const { job, objects, remaining, attempted, logger } = setup(
        [
          row("recent", 97.5 * GB, 1),
          row("old-00", GB, 100, GB),
          row("old-01", GB, 99),
        ],
        { s3Failing: [failing] },
      );

      const deleted = await job.process();

      expect(remaining()).toEqual(["recent", "old-00", "old-01"]);
      expect(deleted).toBe(0);
      expect(objects.has(failing)).toBe(true);
      expect(attempted()).toEqual(["old-00"]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[clean-demos] unable to delete demo old-00"),
      );
    },
  );

  it("stops when the row cannot be deleted, and the next run finishes it", async () => {
    const rows = [row("recent", 98 * GB, 1), ...oldDemos(3, GB)];
    const first = setup(rows, { rowDeleteFailing: ["old-00"] });

    const deleted = await first.job.process();

    expect(first.remaining()).toEqual(["recent", "old-00", "old-01", "old-02"]);
    expect(deleted).toBe(0);
    expect(first.objects.has("demos/match/old-00.dem")).toBe(false);
    expect(first.attempted()).toEqual(["old-00"]);

    const next = setup(rows.slice());
    next.objects.delete("demos/match/old-00.dem");

    await expect(next.job.process()).resolves.toBe(1);
    expect(next.remaining()).toEqual(["recent", "old-01", "old-02"]);
  });

  it("stops when a demo it deleted is listed again", async () => {
    const { job, attempted, logger } = setup(
      [row("recent", 100 * GB, 1), ...oldDemos(12, GB)],
      { rowDeleteIgnored: ["old-00"] },
    );

    await job.process();

    expect(attempted()).toHaveLength(10);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("old-00"));
  });
});
