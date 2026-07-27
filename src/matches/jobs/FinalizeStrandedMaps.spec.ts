import { FinalizeStrandedMaps } from "./FinalizeStrandedMaps";

const secondsAgo = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();

const strandedMap = (overrides: Record<string, any> = {}) => ({
  id: "map-1",
  status: "WaitingForTV",
  match_id: "match-1",
  winning_lineup_id: "lineup-2",
  lineup_1_score: 10,
  lineup_2_score: 13,
  match: {
    lineup_1_id: "lineup-1",
    lineup_2_id: "lineup-2",
    options: {
      tv_delay: 115,
    },
  },
  rounds: [{ time: secondsAgo(1000) }],
  ...overrides,
});

describe("FinalizeStrandedMaps", () => {
  const logger = {
    warn: jest.fn(),
  };
  const hasura = {
    query: jest.fn(),
    mutation: jest.fn(),
  };

  let job: FinalizeStrandedMaps;
  let matchMaps: any[];

  beforeEach(() => {
    jest.clearAllMocks();
    matchMaps = [];
    hasura.query.mockImplementation(async () => ({ match_maps: matchMaps }));
    hasura.mutation.mockResolvedValue({});
    job = new FinalizeStrandedMaps(logger as any, hasura as any);
  });

  it("finishes a map stranded past the handshake deadline with the reported winner", async () => {
    matchMaps = [strandedMap()];

    await expect(job.process()).resolves.toBe(1);

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_match_maps_by_pk: expect.objectContaining({
          __args: {
            pk_columns: { id: "map-1" },
            _set: {
              status: "Finished",
              winning_lineup_id: "lineup-2",
            },
          },
        }),
      }),
    );
  });

  it("leaves a map alone while the server is still inside its tv_delay window", async () => {
    matchMaps = [strandedMap({ rounds: [{ time: secondsAgo(60) }] })];

    await expect(job.process()).resolves.toBe(0);

    expect(hasura.mutation).not.toHaveBeenCalled();
  });

  it("derives the winner from the score when the server never reported one", async () => {
    matchMaps = [
      strandedMap({
        winning_lineup_id: null,
        lineup_1_score: 13,
        lineup_2_score: 4,
      }),
    ];

    await expect(job.process()).resolves.toBe(1);

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_match_maps_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              status: "Finished",
              winning_lineup_id: "lineup-1",
            },
          }),
        }),
      }),
    );
  });

  it("finishes a tied map without a winner rather than leaving it stranded", async () => {
    matchMaps = [
      strandedMap({
        winning_lineup_id: null,
        lineup_1_score: 12,
        lineup_2_score: 12,
      }),
    ];

    await expect(job.process()).resolves.toBe(1);

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_match_maps_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              status: "Finished",
            },
          }),
        }),
      }),
    );
  });

  it("skips maps with no rounds, which have no end-of-game anchor", async () => {
    matchMaps = [strandedMap({ rounds: [] })];

    await expect(job.process()).resolves.toBe(0);

    expect(hasura.mutation).not.toHaveBeenCalled();
  });
});
