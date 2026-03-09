import { Logger } from "@nestjs/common";
import { CleanAbandonedMatches } from "./CleanAbandonedMatches";

function createProcessor() {
  const hasura = {
    mutation: jest
      .fn()
      .mockResolvedValue({ delete_abandoned_matches: { affected_rows: 0 } }),
  };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;

  const processor = new CleanAbandonedMatches(logger, hasura as any);

  return { processor, hasura, logger };
}

describe("CleanAbandonedMatches", () => {
  it("deletes abandoned matches older than 1 week", async () => {
    const { processor, hasura } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      delete_abandoned_matches: { affected_rows: 5 },
    });

    const count = await processor.process();

    expect(count).toBe(5);
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_abandoned_matches: expect.objectContaining({
          __args: expect.objectContaining({
            where: expect.objectContaining({
              abandoned_at: expect.objectContaining({
                _lt: expect.any(Date),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("logs when rows are affected", async () => {
    const { processor, hasura, logger } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      delete_abandoned_matches: { affected_rows: 3 },
    });

    await processor.process();

    expect(logger.log).toHaveBeenCalledWith("3 abandoned matches deleted");
  });

  it("returns 0 and does not log when nothing to clean", async () => {
    const { processor, hasura, logger } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      delete_abandoned_matches: { affected_rows: 0 },
    });

    const count = await processor.process();

    expect(count).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
  });
});
