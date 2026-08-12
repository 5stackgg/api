import { CancelExpiredMatches } from "./CancelExpiredMatches";
import { DISCORD_COLORS } from "../../notifications/utilities/constants";

// Defaults to a genuine no-show (nobody connected), which is what the
// forfeit / organizer-attention paths below are asserting against.
const expiredTournamentMatch = (overrides: Record<string, any> = {}) => ({
  id: "match-1",
  server_id: "server-1",
  // Already past the deadline unless a test says otherwise.
  cancels_at: new Date(Date.now() - 1000).toISOString(),
  is_tournament_match: true,
  options: {
    match_mode: "auto",
  },
  lineup_1: {
    id: "lineup-1",
    is_ready: false,
    lineup_players: [{ steam_id: "1", is_connected: false }],
  },
  lineup_2: {
    id: "lineup-2",
    is_ready: false,
    lineup_players: [{ steam_id: "2", is_connected: false }],
  },
  ...overrides,
});

const connectedLineup = (id: string, steamId: string) => ({
  id,
  is_ready: false,
  lineup_players: [{ steam_id: steamId, is_connected: true }],
});

describe("CancelExpiredMatches", () => {
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
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
  const rconClient = {
    send: jest.fn(),
  };
  const rcon = {
    connect: jest.fn(),
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
    rcon.connect.mockResolvedValue(rconClient);
    rconClient.send.mockResolvedValue("");
    job = new CancelExpiredMatches(
      logger as any,
      hasura as any,
      notifications as any,
      configService as any,
      rcon as any,
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

  it("force starts instead of forfeiting when everyone connected", async () => {
    tournamentMatches = [
      expiredTournamentMatch({
        lineup_1: connectedLineup("lineup-1", "1"),
        lineup_2: connectedLineup("lineup-2", "2"),
      }),
    ];

    await expect(job.process()).resolves.toBe(1);

    expect(rcon.connect).toHaveBeenCalledWith("server-1");
    expect(rconClient.send).toHaveBeenCalledWith("force_ready");
    // cancels_at cleared so the job stops re-picking it up, and crucially no forfeit.
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { cancels_at: null },
          }),
        }),
      }),
    );
    expect(hasura.mutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({ status: "Forfeit" }),
          }),
        }),
      }),
    );
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it("force starts non-tournament matches too, rather than cancelling them", async () => {
    tournamentMatches = [
      expiredTournamentMatch({
        is_tournament_match: false,
        lineup_1: connectedLineup("lineup-1", "1"),
        lineup_2: connectedLineup("lineup-2", "2"),
      }),
    ];

    await job.process();

    expect(rconClient.send).toHaveBeenCalledWith("force_ready");
    expect(hasura.mutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: expect.objectContaining({ status: "Canceled" }),
          }),
        }),
      }),
    );
  });

  it("cancels a non-tournament match when someone never showed up", async () => {
    tournamentMatches = [
      expiredTournamentMatch({
        is_tournament_match: false,
        lineup_1: connectedLineup("lineup-1", "1"),
      }),
    ];

    await job.process();

    expect(rconClient.send).not.toHaveBeenCalledWith("force_ready");
    // Players still in the server are told, since nothing polls for match state.
    expect(rconClient.send).toHaveBeenCalledWith(
      expect.stringContaining("Match canceled"),
    );
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { status: "Canceled" },
          }),
        }),
      }),
    );
  });

  describe("no-show penalties on cancellation", () => {
    const abandonedFor = () =>
      hasura.mutation.mock.calls
        .map(([arg]: [any]) => arg?.insert_abandoned_matches)
        .filter(Boolean)
        .flatMap((call: any) => call.__args.objects)
        .map((row: any) => row.steam_id);

    it("penalises only the players who never connected", async () => {
      tournamentMatches = [
        expiredTournamentMatch({
          is_tournament_match: false,
          lineup_1: {
            id: "lineup-1",
            is_ready: false,
            lineup_players: [
              { steam_id: "showed-up", is_connected: true },
              { steam_id: "no-show-a", is_connected: false },
            ],
          },
          lineup_2: {
            id: "lineup-2",
            is_ready: false,
            lineup_players: [
              { steam_id: "no-show-b", is_connected: false },
            ],
          },
        }),
      ];

      await job.process();

      const penalised = abandonedFor();
      expect(penalised.sort()).toEqual(["no-show-a", "no-show-b"]);
      // The one who turned up carries nothing for a match that never started.
      expect(penalised).not.toContain("showed-up");
    });

    it("penalises nobody when no server was ever assigned", async () => {
      tournamentMatches = [
        expiredTournamentMatch({
          is_tournament_match: false,
          server_id: null,
        }),
      ];

      await job.process();

      // Nobody could have connected, so this is our failure, not theirs.
      expect(abandonedFor()).toEqual([]);
    });

    it("does not record no-shows when the match force starts instead", async () => {
      tournamentMatches = [
        expiredTournamentMatch({
          is_tournament_match: false,
          lineup_1: connectedLineup("lineup-1", "1"),
          lineup_2: connectedLineup("lineup-2", "2"),
        }),
      ];

      await job.process();

      expect(abandonedFor()).toEqual([]);
    });

    it("penalises nobody when a match that already went live is cleaned up", async () => {
      // cancels_at doubles as the hung-live-match safety net. Everyone here
      // played and then disconnected from a dead server, so is_connected reads
      // false for all of them -- but nobody no-showed.
      tournamentMatches = [
        expiredTournamentMatch({
          is_tournament_match: false,
          match_maps: [{ status: "Live" }],
          lineup_1: {
            id: "lineup-1",
            is_ready: true,
            lineup_players: [
              { steam_id: "played-a", is_connected: false },
              { steam_id: "played-b", is_connected: false },
            ],
          },
          lineup_2: {
            id: "lineup-2",
            is_ready: true,
            lineup_players: [{ steam_id: "played-c", is_connected: false }],
          },
        }),
      ];

      await job.process();

      expect(abandonedFor()).toEqual([]);
    });

    it("records no-shows only after the match is marked canceled", async () => {
      // Inserting first leaves the rows behind if the status flip fails, and
      // the next pass re-inserts them -- doubling the cooldown ladder.
      tournamentMatches = [
        expiredTournamentMatch({
          is_tournament_match: false,
          lineup_1: {
            id: "lineup-1",
            is_ready: false,
            lineup_players: [{ steam_id: "no-show-a", is_connected: false }],
          },
          lineup_2: {
            id: "lineup-2",
            is_ready: false,
            lineup_players: [{ steam_id: "no-show-b", is_connected: false }],
          },
        }),
      ];

      await job.process();

      const order = hasura.mutation.mock.calls.map(([arg]: [any]) =>
        arg?.insert_abandoned_matches
          ? "abandon"
          : arg?.update_matches_by_pk?.__args?._set?.status === "Canceled"
            ? "cancel"
            : "other",
      );

      expect(order.indexOf("cancel")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("abandon")).toBeGreaterThan(order.indexOf("cancel"));
    });
  });

  describe("force starting ahead of the deadline", () => {
    // Far enough out to still be inside the lead window but not yet expired.
    const notYetExpired = new Date(Date.now() + 30 * 1000).toISOString();

    it("looks ahead of the deadline when selecting matches", async () => {
      await job.process();

      const matchesQuery = hasura.query.mock.calls
        .map(([arg]: [any]) => arg?.matches)
        .find(Boolean);

      const bound = matchesQuery.__args.where._and.find(
        (clause: any) => clause.cancels_at?._lte,
      ).cancels_at._lte;

      // Without the lead time this bound is "now" and a lobby that fills in the
      // final seconds is cancelled in the same pass that would have started it.
      expect(new Date(bound).getTime()).toBeGreaterThan(Date.now() + 30_000);
    });

    it("starts a full lobby before its deadline rather than letting it expire", async () => {
      tournamentMatches = [
        expiredTournamentMatch({
          is_tournament_match: false,
          cancels_at: notYetExpired,
          lineup_1: connectedLineup("lineup-1", "1"),
          lineup_2: connectedLineup("lineup-2", "2"),
        }),
      ];

      await job.process();

      expect(rconClient.send).toHaveBeenCalledWith("force_ready");
    });

    it("leaves a short lobby alone until its deadline actually passes", async () => {
      tournamentMatches = [
        expiredTournamentMatch({
          is_tournament_match: false,
          cancels_at: notYetExpired,
          lineup_1: connectedLineup("lineup-1", "1"),
          // lineup 2 still has a no-show, so there is nothing to start yet.
        }),
      ];

      await job.process();

      expect(rconClient.send).not.toHaveBeenCalledWith("force_ready");
      // Crucially it is not cancelled either -- they still have time.
      expect(hasura.mutation).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update_matches_by_pk: expect.objectContaining({
            __args: expect.objectContaining({
              _set: { status: "Canceled" },
            }),
          }),
        }),
      );
    });
  });

  it("does not force start a match that is already underway", async () => {
    // An expired cancels_at on a live match is the hung-match safety net, not
    // the warmup no-show deadline. Everyone here connected long ago, so the
    // no-show check alone would wrongly treat this as "just needs a nudge".
    tournamentMatches = [
      expiredTournamentMatch({
        is_tournament_match: false,
        match_maps: [{ status: "Live" }],
        lineup_1: connectedLineup("lineup-1", "1"),
        lineup_2: connectedLineup("lineup-2", "2"),
      }),
    ];

    await job.process();

    expect(rconClient.send).not.toHaveBeenCalledWith("force_ready");
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { status: "Canceled" },
          }),
        }),
      }),
    );
  });

  it("falls back to the normal expiry path when force start fails", async () => {
    rconClient.send.mockRejectedValue(new Error("rcon down"));
    tournamentMatches = [
      expiredTournamentMatch({
        is_tournament_match: false,
        lineup_1: connectedLineup("lineup-1", "1"),
        lineup_2: connectedLineup("lineup-2", "2"),
      }),
    ];

    await job.process();

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_matches_by_pk: expect.objectContaining({
          __args: expect.objectContaining({
            _set: { status: "Canceled" },
          }),
        }),
      }),
    );
  });
});
