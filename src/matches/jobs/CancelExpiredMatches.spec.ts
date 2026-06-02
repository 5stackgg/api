import { CancelExpiredMatches } from "./CancelExpiredMatches";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

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
  const configService = {
    get: jest.fn(),
  };

  let job: CancelExpiredMatches;
  let tournamentMatches: any[];
  let pendingNotificationCount: number;

  beforeEach(() => {
    jest.clearAllMocks();
    tournamentMatches = [];
    pendingNotificationCount = 0;
    hasura.mutation.mockResolvedValue({
      update_matches: {
        affected_rows: 0,
      },
    });
    hasura.query.mockImplementation(async (query: any) => {
      if (query.notifications_aggregate) {
        return {
          notifications_aggregate: {
            aggregate: { count: pendingNotificationCount },
          },
        };
      }
      return { matches: tournamentMatches };
    });
    configService.get.mockReturnValue({ webDomain: "https://example.com" });
    job = new CancelExpiredMatches(
      logger as any,
      hasura as any,
      notifications as any,
      configService as any,
    );
  });

  it("requests organizer attention for admin-mode tournament matches when neither lineup is ready", async () => {
    tournamentMatches = [
      expiredTournamentMatch({
        options: {
          match_mode: "admin",
        },
      }),
    ];

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
    expect(notifications.send).toHaveBeenCalledWith(
      "MatchSupport",
      expect.objectContaining({
        message: expect.stringContaining(
          'href="https://example.com/matches/match-1"',
        ),
        title: "Tournament match requires attention",
        role: "tournament_organizer",
        entity_id: "match-1",
      }),
      undefined,
      DISCORD_COLORS.RED,
    );
  });

  it("does not re-notify when an organizer notification is already pending", async () => {
    pendingNotificationCount = 1;
    tournamentMatches = [
      expiredTournamentMatch({
        options: {
          match_mode: "admin",
        },
      }),
    ];

    await job.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: {
              cancels_at: null,
            },
          }),
        }),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("forfeits auto-mode tournament matches when neither lineup is ready", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.25);
    tournamentMatches = [expiredTournamentMatch()];

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
    tournamentMatches = [
      expiredTournamentMatch({
        options: {
          match_mode: "admin",
        },
        lineup_2: {
          id: "lineup-2",
          is_ready: true,
        },
      }),
    ];

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
