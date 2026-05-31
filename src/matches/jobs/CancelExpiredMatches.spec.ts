import { CancelExpiredMatches } from "./CancelExpiredMatches";

const expiredTournamentMatch = (overrides: Record<string, any> = {}) => ({
  id: "match-1",
  is_tournament_match: true,
  options: {
    match_mode: "auto",
  },
  lineup_1: {
    id: "lineup-1",
    is_ready: false,
  },
  lineup_2: {
    id: "lineup-2",
    is_ready: false,
  },
  ...overrides,
});

describe("CancelExpiredMatches", () => {
  const logger = {
    log: jest.fn(),
  };
  const hasura = {
    mutation: jest.fn(),
    query: jest.fn(),
  };
  const notifications = {
    send: jest.fn(),
  };

  let job: CancelExpiredMatches;

  beforeEach(() => {
    jest.clearAllMocks();
    hasura.mutation.mockResolvedValue({
      update_matches: {
        affected_rows: 0,
      },
    });
    hasura.query.mockResolvedValue({
      matches: [],
    });
    job = new CancelExpiredMatches(
      logger as any,
      hasura as any,
      notifications as any,
    );
  });

  it("requests organizer attention for admin-mode tournament matches when neither lineup is ready", async () => {
    hasura.query.mockResolvedValue({
      matches: [
        expiredTournamentMatch({
          options: {
            match_mode: "admin",
          },
        }),
      ],
    });

    await expect(job.process()).resolves.toBe(1);

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            pk_columns: {
              id: "match-1",
            },
            _set: {
              cancels_at: null,
            },
          }),
        }),
      }),
    );
    expect(hasura.mutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({
              status: "Forfeit",
            }),
          }),
        }),
      }),
    );
    expect(notifications.send).toHaveBeenCalledWith("MatchSupport", {
      message: "Tournament match requires admin attention: match-1",
      title: "Tournament match requires attention",
      role: "tournament_organizer",
      entity_id: "match-1",
    });
  });

  it("forfeits auto-mode tournament matches when neither lineup is ready", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.25);
    hasura.query.mockResolvedValue({
      matches: [expiredTournamentMatch()],
    });

    await job.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            pk_columns: {
              id: "match-1",
            },
            _set: {
              status: "Forfeit",
              winning_lineup_id: "lineup-1",
            },
          }),
        }),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("forfeits to the ready lineup even in admin mode", async () => {
    hasura.query.mockResolvedValue({
      matches: [
        expiredTournamentMatch({
          options: {
            match_mode: "admin",
          },
          lineup_2: {
            id: "lineup-2",
            is_ready: true,
          },
        }),
      ],
    });

    await job.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              status: "Forfeit",
              winning_lineup_id: "lineup-2",
            },
          }),
        }),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });
});
