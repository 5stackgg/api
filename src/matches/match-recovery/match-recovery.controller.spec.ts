import { MatchRecoveryController } from "./match-recovery.controller";

describe("MatchRecoveryController", () => {
  const user = { steam_id: "76561198000000001" } as never;

  const setup = (organizer: boolean) => {
    const matchAssistant = { isOrganizer: jest.fn(async () => organizer) };
    const recovery = {
      getRestoreRounds: jest.fn(async () => ({ rounds: [] as Array<unknown> })),
      restoreRound: jest.fn(async () => ({ success: true })),
      restartMatch: jest.fn(async () => ({ success: true })),
      restartMatchMap: jest.fn(async () => ({ success: true })),
      rewindMapVeto: jest.fn(async () => ({ success: true })),
      extendVetoClock: jest.fn(async () => ({ success: true })),
    };

    return {
      controller: new MatchRecoveryController(
        matchAssistant as never,
        recovery as never,
      ),
      recovery,
    };
  };

  it("keeps every action to the match's organizers", async () => {
    const { controller, recovery } = setup(false);

    await expect(
      controller.getMatchRestoreRounds({ match_id: "match-1", user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.restoreMatchRound({ match_id: "match-1", round: 4, user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.restartMatch({ match_id: "match-1", user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.restartMatchMap({ match_id: "match-1", user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.rewindMapVeto({ match_id: "match-1", step: 3, user }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.extendVetoClock({ match_id: "match-1", seconds: 30, user }),
    ).rejects.toThrow("you are not a match organizer");

    expect(recovery.getRestoreRounds).not.toHaveBeenCalled();
    expect(recovery.restoreRound).not.toHaveBeenCalled();
    expect(recovery.restartMatch).not.toHaveBeenCalled();
    expect(recovery.restartMatchMap).not.toHaveBeenCalled();
    expect(recovery.rewindMapVeto).not.toHaveBeenCalled();
    expect(recovery.extendVetoClock).not.toHaveBeenCalled();
  });

  it("hands organizers' requests to the service", async () => {
    const { controller, recovery } = setup(true);

    await controller.getMatchRestoreRounds({ match_id: "match-1", user });
    await controller.restoreMatchRound({ match_id: "match-1", round: 4, user });
    await controller.restartMatch({ match_id: "match-1", user });
    await controller.restartMatchMap({ match_id: "match-1", user });
    await controller.rewindMapVeto({
      match_id: "match-1",
      step: 3,
      expected_picks: 5,
      user,
    });
    await controller.extendVetoClock({
      match_id: "match-1",
      seconds: 30,
      user,
    });

    expect(recovery.getRestoreRounds).toHaveBeenCalledWith("match-1", user);
    expect(recovery.restoreRound).toHaveBeenCalledWith("match-1", 4, user);
    expect(recovery.restartMatch).toHaveBeenCalledWith("match-1");
    expect(recovery.restartMatchMap).toHaveBeenCalledWith("match-1", user);
    expect(recovery.rewindMapVeto).toHaveBeenCalledWith("match-1", 3, 5);
    expect(recovery.extendVetoClock).toHaveBeenCalledWith("match-1", 30);
  });
});
