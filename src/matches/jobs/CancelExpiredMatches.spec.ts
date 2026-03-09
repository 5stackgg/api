import { Logger } from "@nestjs/common";
import { CancelExpiredMatches } from "./CancelExpiredMatches";

function createProcessor() {
  const hasura = {
    query: jest.fn().mockResolvedValue({ matches: [] }),
    mutation: jest.fn().mockResolvedValue({ update_matches: { affected_rows: 0 } }),
  };
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as unknown as Logger;

  const processor = new CancelExpiredMatches(logger, hasura as any);

  return { processor, hasura, logger };
}

describe("CancelExpiredMatches", () => {
  it("cancels non-tournament expired matches via mutation", async () => {
    const { processor, hasura } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({ update_matches: { affected_rows: 3 } });
    hasura.query.mockResolvedValueOnce({ matches: [] });

    const count = await processor.process({} as any);

    expect(count).toBe(3);
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { status: "Canceled" },
          }),
        }),
      }),
    );
  });

  it("forfeits tournament matches with lineup_1 ready", async () => {
    const { processor, hasura } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({ update_matches: { affected_rows: 0 } });
    hasura.query.mockResolvedValueOnce({
      matches: [
        {
          id: "m1",
          is_tournament_match: true,
          lineup_1: { id: "lineup-1", is_ready: true },
          lineup_2: { id: "lineup-2", is_ready: false },
        },
      ],
    });

    const count = await processor.process({} as any);

    expect(count).toBe(1);
    // Forfeit should set winning_lineup_id to lineup_1 since it's ready
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({
              status: "Forfeit",
              winning_lineup_id: "lineup-1",
            }),
          }),
        }),
      }),
    );
  });

  it("forfeits tournament matches with lineup_2 ready", async () => {
    const { processor, hasura } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({ update_matches: { affected_rows: 0 } });
    hasura.query.mockResolvedValueOnce({
      matches: [
        {
          id: "m2",
          is_tournament_match: true,
          lineup_1: { id: "lineup-a", is_ready: false },
          lineup_2: { id: "lineup-b", is_ready: true },
        },
      ],
    });

    await processor.process({} as any);

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({
              winning_lineup_id: "lineup-b",
            }),
          }),
        }),
      }),
    );
  });

  it("returns 0 and does not log when no matches expired", async () => {
    const { processor, hasura, logger } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({ update_matches: { affected_rows: 0 } });
    hasura.query.mockResolvedValueOnce({ matches: [] });

    const count = await processor.process({} as any);

    expect(count).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("logs total canceled count when matches were canceled", async () => {
    const { processor, hasura, logger } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({ update_matches: { affected_rows: 2 } });
    hasura.query.mockResolvedValueOnce({
      matches: [
        {
          id: "m1",
          is_tournament_match: true,
          lineup_1: { id: "l1", is_ready: true },
          lineup_2: { id: "l2", is_ready: false },
        },
      ],
    });

    await processor.process({} as any);

    expect(logger.log).toHaveBeenCalledWith("canceled 3 matches");
  });
});
