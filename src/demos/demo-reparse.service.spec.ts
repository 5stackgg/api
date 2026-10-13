import { DemoReparseService } from "./demo-reparse.service";

// Re-parses run two at a time, but never two demos of the same match map at
// once: both would write that map's stats.
describe("DemoReparseService.runReparseAll", () => {
  const make = (demos: Array<{ id: string; match_map_id: string }>) => {
    let running = 0;
    let peak = 0;
    const runningMaps = new Set<string>();
    const overlaps: string[] = [];
    const order: string[] = [];
    const mapOf = new Map(demos.map((d) => [d.id, d.match_map_id]));
    const demoMetadata = {
      reparseById: jest.fn(async (id: string) => {
        const map = mapOf.get(id)!;
        if (runningMaps.has(map)) {
          overlaps.push(map);
        }
        runningMaps.add(map);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(id);
        running -= 1;
        runningMaps.delete(map);
        if (id === "fail") {
          throw new Error("boom");
        }
      }),
    };
    const hasura = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ match_map_demos: demos })
        .mockResolvedValue({ match_map_demos: [] }),
    };
    const s3 = { put: jest.fn(), has: jest.fn(), get: jest.fn() };
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new DemoReparseService(
      logger as any,
      hasura as any,
      s3 as any,
      demoMetadata as any,
    );
    return {
      service,
      peak: () => peak,
      overlaps,
      order,
      status: () => service.getStatus(),
    };
  };

  it("runs two at a time, keeping each match map's demos in order", async () => {
    const demos = [
      { id: "a1", match_map_id: "A" },
      { id: "b1", match_map_id: "B" },
      { id: "a2", match_map_id: "A" },
      { id: "c1", match_map_id: "C" },
      { id: "fail", match_map_id: "D" },
      { id: "b2", match_map_id: "B" },
    ];
    const run = make(demos);
    await run.service.runReparseAll();

    expect(run.peak()).toBe(2);
    expect(run.overlaps).toEqual([]);
    expect(run.order.indexOf("a1")).toBeLessThan(run.order.indexOf("a2"));
    expect(run.order.indexOf("b1")).toBeLessThan(run.order.indexOf("b2"));
    const status = await run.status();
    expect(status).toMatchObject({
      running: false,
      canceled: false,
      total: 6,
      completed: 6,
      failed: 1,
    });
  });

  it("groups demos by match map in the order maps first appear", () => {
    expect(
      DemoReparseService.groupByMatchMap([
        { id: "1", match_map_id: "x" },
        { id: "2", match_map_id: "y" },
        { id: "3", match_map_id: "x" },
      ]),
    ).toEqual([["1", "3"], ["2"]]);
  });
});
