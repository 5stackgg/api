import { Logger } from "@nestjs/common";
import { CheckForTournamentStart } from "./CheckForTournamentStart";

function createProcessor() {
  const hasura = {
    mutation: jest
      .fn()
      .mockResolvedValue({ update_tournaments: { affected_rows: 0 } }),
  };
  const logger = { log: jest.fn(), error: jest.fn() } as unknown as Logger;

  const processor = new CheckForTournamentStart(logger, hasura as any);

  return { processor, hasura, logger };
}

describe("CheckForTournamentStart", () => {
  it("transitions eligible tournaments to Live", async () => {
    const { processor, hasura } = createProcessor();
    hasura.mutation.mockResolvedValueOnce({
      update_tournaments: { affected_rows: 2 },
    });

    const result = await processor.process({} as any);

    expect(result).toBe(2);
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_tournaments: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { status: "Live" },
          }),
        }),
      }),
    );
  });

  it("filters by RegistrationOpen and RegistrationClosed statuses", async () => {
    const { processor, hasura } = createProcessor();

    await processor.process({} as any);

    const args = hasura.mutation.mock.calls[0][0].update_tournaments.__args;
    expect(args.where._and).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: { _in: ["RegistrationOpen", "RegistrationClosed"] },
        }),
      ]),
    );
  });

  it("logs count when tournaments started", async () => {
    const { processor, hasura, logger } = createProcessor();
    hasura.mutation.mockResolvedValueOnce({
      update_tournaments: { affected_rows: 3 },
    });

    await processor.process({} as any);

    expect(logger.log).toHaveBeenCalledWith("3 tournaments started");
  });

  it("does not log when no tournaments started", async () => {
    const { processor, logger } = createProcessor();

    await processor.process({} as any);

    expect(logger.log).not.toHaveBeenCalled();
  });

  it("returns 0 when no tournaments match", async () => {
    const { processor } = createProcessor();

    const result = await processor.process({} as any);

    expect(result).toBe(0);
  });

  it("catches and logs mutation errors", async () => {
    const { processor, hasura, logger } = createProcessor();
    hasura.mutation.mockRejectedValueOnce(new Error("DB error"));

    await processor.process({} as any);

    expect(logger.error).toHaveBeenCalledWith(
      "cannot update tournaments",
      expect.any(String),
    );
  });
});
