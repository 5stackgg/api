import { ResolveMatchMetadata } from "./ResolveMatchMetadata";

const VALVE_MATCH_ID = "1174469974867590708";

const build = () => {
  const failures: unknown[][] = [];
  const postgres = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT share_code")) {
        throw new Error('column "parties" does not exist');
      }
      if (sql.includes("SET status = 'Failed'")) {
        failures.push(params);
      }
      return [];
    }),
  };
  const logger = { log: jest.fn(), warn: jest.fn() };

  const job = new ResolveMatchMetadata(
    logger as never,
    postgres as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const run = (attemptsMade: number) =>
    job.process({
      data: { valve_match_id: VALVE_MATCH_ID },
      attemptsMade,
      opts: { attempts: 5 },
    } as never);

  return { run, failures };
};

describe("ResolveMatchMetadata", () => {
  it("leaves the row for the retry while attempts remain", async () => {
    const { run, failures } = build();

    await expect(run(0)).rejects.toThrow("parties");

    expect(failures).toHaveLength(0);
  });

  it("marks the row Failed when the last attempt throws", async () => {
    const { run, failures } = build();

    await expect(run(4)).rejects.toThrow("parties");

    expect(failures).toEqual([
      [VALVE_MATCH_ID, 'column "parties" does not exist'],
    ]);
  });
});
