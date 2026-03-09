import { Logger } from "@nestjs/common";
import { TournamentsController } from "./tournaments.controller";

function createController() {
  const hasura = {
    query: jest.fn().mockResolvedValue({}),
    mutation: jest.fn().mockResolvedValue({}),
  };
  const s3 = { remove: jest.fn().mockResolvedValue(undefined) };
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;

  const controller = new TournamentsController(
    logger,
    hasura as any,
    s3 as any,
  );

  return { controller, hasura, s3, logger };
}

describe("TournamentsController - deleteTournament", () => {
  const user = { steam_id: "76561198000000001" } as any;

  it("throws when tournament not found", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({ tournaments_by_pk: null });

    await expect(
      controller.deleteTournament({ user, tournament_id: "t1" }),
    ).rejects.toThrow("tournament not found");
  });

  it("throws when not the organizer", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        id: "t1",
        status: "RegistrationOpen",
        is_organizer: false,
      },
    });

    await expect(
      controller.deleteTournament({ user, tournament_id: "t1" }),
    ).rejects.toThrow("not the tournament organizer");
  });

  it("throws when tournament is Live", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        id: "t1",
        status: "Live",
        is_organizer: true,
      },
    });

    await expect(
      controller.deleteTournament({ user, tournament_id: "t1" }),
    ).rejects.toThrow("cannot delete a live tournament");
  });

  it("cleans up demo files from S3 and deletes matches", async () => {
    const { controller, hasura, s3 } = createController();

    // First query: authorization check
    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        id: "t1",
        status: "RegistrationOpen",
        is_organizer: true,
      },
    });

    // Second query: admin query for stages/brackets/demos
    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        stages: [
          {
            brackets: [
              {
                match: {
                  id: "m1",
                  match_maps: [
                    {
                      demos: [
                        { id: "d1", file: "demos/match1.dem" },
                        { id: "d2", file: "demos/match1b.dem" },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    const result = await controller.deleteTournament({
      user,
      tournament_id: "t1",
    });

    expect(s3.remove).toHaveBeenCalledWith("demos/match1.dem");
    expect(s3.remove).toHaveBeenCalledWith("demos/match1b.dem");
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_match_map_demos_by_pk: expect.objectContaining({
          __args: { id: "d1" },
        }),
      }),
    );
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_matches_by_pk: expect.objectContaining({
          __args: { id: "m1" },
        }),
      }),
    );
    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_tournaments_by_pk: expect.objectContaining({
          __args: { id: "t1" },
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("handles individual demo cleanup failures gracefully", async () => {
    const { controller, hasura, s3, logger } = createController();

    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        id: "t1",
        status: "RegistrationOpen",
        is_organizer: true,
      },
    });

    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        stages: [
          {
            brackets: [
              {
                match: {
                  id: "m1",
                  match_maps: [
                    { demos: [{ id: "d1", file: "demos/fail.dem" }] },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    s3.remove.mockRejectedValueOnce(new Error("S3 error"));

    const result = await controller.deleteTournament({
      user,
      tournament_id: "t1",
    });

    expect(logger.error).toHaveBeenCalledWith(
      "[t1] failed to clean up demo d1",
      expect.any(Error),
    );
    expect(result).toEqual({ success: true });
  });

  it("handles empty tournament with no stages", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        id: "t1",
        status: "RegistrationOpen",
        is_organizer: true,
      },
    });

    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        stages: [],
      },
    });

    const result = await controller.deleteTournament({
      user,
      tournament_id: "t1",
    });

    expect(hasura.mutation).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_tournaments_by_pk: expect.objectContaining({
          __args: { id: "t1" },
        }),
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("handles bracket with no match", async () => {
    const { controller, hasura } = createController();

    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        id: "t1",
        status: "RegistrationOpen",
        is_organizer: true,
      },
    });

    hasura.query.mockResolvedValueOnce({
      tournaments_by_pk: {
        stages: [
          {
            brackets: [{ match: null }],
          },
        ],
      },
    });

    const result = await controller.deleteTournament({
      user,
      tournament_id: "t1",
    });

    expect(result).toEqual({ success: true });
  });
});
