import { Logger } from "@nestjs/common";
import { CancelInvalidTournaments } from "./CancelInvalidTournaments";

function createProcessor() {
  const hasura = {
    mutation: jest
      .fn()
      .mockResolvedValue({ update_tournaments: { affected_rows: 0 } }),
  };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;

  const processor = new CancelInvalidTournaments(logger, hasura as any);

  return { processor, hasura, logger };
}

describe("CancelInvalidTournaments", () => {
  it("cancels tournaments without min teams past start date", async () => {
    const { processor, hasura } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      update_tournaments: { affected_rows: 2 },
    });

    const count = await processor.process();

    expect(count).toBe(2);
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_tournaments: expect.objectContaining({
          __args: expect.objectContaining({
            where: expect.objectContaining({
              _and: expect.arrayContaining([
                expect.objectContaining({
                  status: { _eq: "RegistrationOpen" },
                }),
                expect.objectContaining({
                  has_min_teams: { _eq: false },
                }),
                expect.objectContaining({
                  start: { _gte: expect.any(Date) },
                }),
              ]),
            }),
          }),
        }),
      }),
    );
  });

  it("logs count when tournaments are cancelled", async () => {
    const { processor, hasura, logger } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      update_tournaments: { affected_rows: 4 },
    });

    await processor.process();

    expect(logger.log).toHaveBeenCalledWith("4 matches started");
  });

  it("returns 0 and does not log when none found", async () => {
    const { processor, hasura, logger } = createProcessor();

    hasura.mutation.mockResolvedValueOnce({
      update_tournaments: { affected_rows: 0 },
    });

    const count = await processor.process();

    expect(count).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
  });
});
