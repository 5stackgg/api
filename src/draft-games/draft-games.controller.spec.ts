import { DraftGamesController } from "./draft-games.controller";

describe("DraftGamesController draft_game_deadlines", () => {
  const NOW = new Date("2026-10-20T12:00:00.000Z").getTime();

  let queue: { add: jest.Mock };
  let controller: DraftGamesController;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    queue = { add: jest.fn() };
    controller = new DraftGamesController(
      {} as any,
      {} as any,
      {} as any,
      queue as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("wakes the expiry sweep when an open draft's time runs out", async () => {
    await controller.draft_game_deadlines({
      op: "INSERT",
      old: {},
      new: {
        status: "Open",
        expires_at: new Date(NOW + 30 * 60 * 1000).toISOString(),
      },
    });

    expect(queue.add).toHaveBeenCalledWith(
      "CleanExpiredDraftGames",
      {},
      expect.objectContaining({ delay: 30 * 60 * 1000 + 2000 }),
    );
  });

  it("leaves a draft that has moved on alone", async () => {
    await controller.draft_game_deadlines({
      op: "UPDATE",
      old: { status: "Open" },
      new: {
        status: "Filled",
        expires_at: new Date(NOW + 30 * 60 * 1000).toISOString(),
      },
    });

    expect(queue.add).not.toHaveBeenCalled();
  });
});
