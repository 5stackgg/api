import { DeadlinesController } from "./deadlines.controller";

describe("DeadlinesController", () => {
  const current = new Date("2026-10-20T12:01:00.000Z");

  let deadlines: {
    armMatch: jest.Mock;
    armTournament: jest.Mock;
    armBracket: jest.Mock;
    scheduleVetoPickTimeout: jest.Mock;
  };
  let controller: DeadlinesController;

  beforeEach(() => {
    deadlines = {
      armMatch: jest.fn().mockResolvedValue({
        id: "m",
        veto_pick_expires_at: current,
      }),
      armTournament: jest.fn(),
      armBracket: jest.fn(),
      scheduleVetoPickTimeout: jest.fn(),
    };
    controller = new DeadlinesController(deadlines as any);
  });

  it("arms the veto timer from the row as it is now, not the payload that was delivered", async () => {
    await controller.match_deadlines({
      op: "UPDATE",
      old: { id: "m", veto_pick_expires_at: null },
      new: { id: "m", veto_pick_expires_at: "2026-10-20T12:00:00.000Z" },
    });

    expect(deadlines.armMatch).toHaveBeenCalledWith("m");
    expect(deadlines.scheduleVetoPickTimeout).toHaveBeenCalledWith(
      "m",
      current,
    );
  });

  it("leaves the veto timer alone when only the other deadlines moved", async () => {
    await controller.match_deadlines({
      op: "UPDATE",
      old: { id: "m", veto_pick_expires_at: "2026-10-20T12:00:00.000Z" },
      new: { id: "m", veto_pick_expires_at: "2026-10-20T12:00:00.000Z" },
    });

    expect(deadlines.armMatch).toHaveBeenCalledWith("m");
    expect(deadlines.scheduleVetoPickTimeout).not.toHaveBeenCalled();
  });

  it("cancels the veto timer of a match that no longer exists", async () => {
    deadlines.armMatch.mockResolvedValue(undefined);

    await controller.match_deadlines({
      op: "UPDATE",
      old: { id: "m", veto_pick_expires_at: "2026-10-20T12:00:00.000Z" },
      new: { id: "m", veto_pick_expires_at: null },
    });

    expect(deadlines.scheduleVetoPickTimeout).toHaveBeenCalledWith("m", null);
  });

  it("does not touch veto timers for a match created without a veto running", async () => {
    await controller.match_deadlines({
      op: "INSERT",
      old: {},
      new: { id: "m", veto_pick_expires_at: null },
    });

    expect(deadlines.armMatch).toHaveBeenCalledWith("m");
    expect(deadlines.scheduleVetoPickTimeout).not.toHaveBeenCalled();
  });

  it("arms a tournament and a bracket by id", async () => {
    await controller.tournament_deadlines({
      op: "UPDATE",
      old: { id: "t" },
      new: { id: "t" },
    });
    await controller.tournament_bracket_deadlines({
      op: "INSERT",
      old: {},
      new: { id: "b" },
    });

    expect(deadlines.armTournament).toHaveBeenCalledWith("t");
    expect(deadlines.armBracket).toHaveBeenCalledWith("b");
  });
});
