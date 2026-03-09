import { Logger } from "@nestjs/common";
import { CheckForScheduledMatches } from "./CheckForScheduledMatches";

function createProcessor() {
  const hasura = {
    mutation: jest
      .fn()
      .mockResolvedValue({ update_matches: { affected_rows: 0 } }),
  };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;

  const processor = new CheckForScheduledMatches(logger, hasura as any);

  return { processor, hasura, logger };
}

describe("CheckForScheduledMatches", () => {
  it("transitions Scheduled matches to WaitingForCheckIn within 15 min window", async () => {
    const { processor, hasura } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      update_matches: { affected_rows: 3 },
    });

    const count = await processor.process();

    expect(count).toBe(3);
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches: expect.objectContaining({
          __args: expect.objectContaining({
            where: expect.objectContaining({
              _and: expect.arrayContaining([
                expect.objectContaining({
                  scheduled_at: { _is_null: false },
                }),
                expect.objectContaining({
                  scheduled_at: { _lte: expect.any(Date) },
                }),
                expect.objectContaining({
                  status: { _eq: "Scheduled" },
                }),
              ]),
            }),
            _set: { status: "WaitingForCheckIn" },
          }),
        }),
      }),
    );
  });

  it("logs count when matches are transitioned", async () => {
    const { processor, hasura, logger } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      update_matches: { affected_rows: 2 },
    });

    await processor.process();

    expect(logger.log).toHaveBeenCalledWith("2 matches started");
  });

  it("returns 0 and does not log when none found", async () => {
    const { processor, hasura, logger } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      update_matches: { affected_rows: 0 },
    });

    const count = await processor.process();

    expect(count).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
  });
});
