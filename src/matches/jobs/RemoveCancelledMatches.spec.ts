jest.mock("@nestjs/bullmq", () => ({
  WorkerHost: class {},
}));

jest.mock("../../utilities/QueueProcessors", () => ({
  UseQueue: () => () => {},
}));

import { RemoveCancelledMatches } from "./RemoveCancelledMatches";

function createProcessor(matches: any[] = []) {
  const hasura = {
    query: jest.fn().mockResolvedValue({ matches }),
    mutation: jest.fn().mockResolvedValue({}),
  };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  const s3Service = { remove: jest.fn().mockResolvedValue(undefined) };

  const processor = new RemoveCancelledMatches(
    logger as any,
    hasura as any,
    s3Service as any,
  );

  return { processor, hasura, logger, s3Service };
}

describe("RemoveCancelledMatches", () => {
  it("queries cancelled non-tournament matches", async () => {
    const { processor, hasura } = createProcessor();

    await processor.process();

    expect(hasura.query).toHaveBeenCalledTimes(1);
    const args = hasura.query.mock.calls[0][0];
    const where = args.matches.__args.where;
    expect(where).toEqual(
      expect.objectContaining({
        _and: expect.arrayContaining([
          expect.objectContaining({
            is_tournament_match: { _eq: false },
          }),
        ]),
      }),
    );
    const nestedAnd = where._and.find((c: any) => c._and);
    expect(nestedAnd._and).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cancels_at: { _is_null: false } }),
        expect.objectContaining({ cancels_at: expect.objectContaining({ _lte: expect.any(Date) }) }),
      ]),
    );
  });

  it("deletes S3 demo files and demo records for each match map", async () => {
    const matches = [
      {
        id: "m1",
        server_id: "s1",
        match_maps: [
          {
            demos: [
              { id: "d1", file: "demos/d1.dem" },
              { id: "d2", file: "demos/d2.dem" },
            ],
            rounds: [] as any[],
          },
        ],
      },
    ];
    const { processor, hasura, s3Service } = createProcessor(matches);

    await processor.process();

    expect(s3Service.remove).toHaveBeenCalledWith("demos/d1.dem");
    expect(s3Service.remove).toHaveBeenCalledWith("demos/d2.dem");
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_match_map_demos_by_pk: expect.objectContaining({
          __args: { id: "d1" },
        }),
      }),
    );
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_match_map_demos_by_pk: expect.objectContaining({
          __args: { id: "d2" },
        }),
      }),
    );
  });

  it("deletes match records after demo cleanup", async () => {
    const matches = [
      { id: "m1", server_id: "s1", match_maps: [{ demos: [] as any[], rounds: [] as any[] }] },
      { id: "m2", server_id: "s2", match_maps: [{ demos: [] as any[], rounds: [] as any[] }] },
    ];
    const { processor, hasura } = createProcessor(matches);

    await processor.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_matches_by_pk: expect.objectContaining({
          __args: { id: "m1" },
        }),
      }),
    );
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_matches_by_pk: expect.objectContaining({
          __args: { id: "m2" },
        }),
      }),
    );
  });

  it("logs count when matches removed", async () => {
    const matches = [
      { id: "m1", server_id: "s1", match_maps: [{ demos: [] as any[], rounds: [] as any[] }] },
      { id: "m2", server_id: "s2", match_maps: [{ demos: [] as any[], rounds: [] as any[] }] },
    ];
    const { processor, logger } = createProcessor(matches);

    await processor.process();

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("2"));
  });

  it("returns 0 when no cancelled matches found", async () => {
    const { processor, logger } = createProcessor([]);

    const result = await processor.process();

    expect(result).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
  });
});
