import { readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { MatchRecoveryController } from "./match-recovery.controller";

const METADATA = join(__dirname, "../../../hasura/metadata");

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
      extendMatchAutoCancel: jest.fn(async () => ({ success: true })),
      setMatchPaused: jest.fn(async () => ({ success: true })),
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
    await expect(
      controller.extendMatchAutoCancel({
        match_id: "match-1",
        minutes: 15,
        user,
      }),
    ).rejects.toThrow("you are not a match organizer");
    await expect(
      controller.setMatchPaused({ match_id: "match-1", paused: true, user }),
    ).rejects.toThrow("you are not a match organizer");

    expect(recovery.getRestoreRounds).not.toHaveBeenCalled();
    expect(recovery.restoreRound).not.toHaveBeenCalled();
    expect(recovery.restartMatch).not.toHaveBeenCalled();
    expect(recovery.restartMatchMap).not.toHaveBeenCalled();
    expect(recovery.rewindMapVeto).not.toHaveBeenCalled();
    expect(recovery.extendVetoClock).not.toHaveBeenCalled();
    expect(recovery.extendMatchAutoCancel).not.toHaveBeenCalled();
    expect(recovery.setMatchPaused).not.toHaveBeenCalled();
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
    await controller.extendMatchAutoCancel({
      match_id: "match-1",
      minutes: 15,
      user,
    });
    await controller.setMatchPaused({
      match_id: "match-1",
      paused: true,
      user,
    });
    await controller.setMatchPaused({
      match_id: "match-1",
      paused: false,
      user,
    });

    expect(recovery.getRestoreRounds).toHaveBeenCalledWith("match-1", user);
    expect(recovery.restoreRound).toHaveBeenCalledWith("match-1", 4, user);
    expect(recovery.restartMatch).toHaveBeenCalledWith("match-1");
    expect(recovery.restartMatchMap).toHaveBeenCalledWith("match-1", user);
    expect(recovery.rewindMapVeto).toHaveBeenCalledWith("match-1", 3, 5);
    expect(recovery.extendVetoClock).toHaveBeenCalledWith("match-1", 30);
    expect(recovery.extendMatchAutoCancel).toHaveBeenCalledWith("match-1", 15);
    expect(recovery.setMatchPaused.mock.calls).toEqual([
      ["match-1", true],
      ["match-1", false],
    ]);
  });

  // The match's creator or a tournament organizer is an organizer whatever
  // their role, though only moderators and above get the RCON console.
  it("lets a user-role organizer pause and resume", async () => {
    const { controller, recovery } = setup(true);
    const creator = { steam_id: "76561198000000002", role: "user" } as never;

    await expect(
      controller.setMatchPaused({
        match_id: "match-1",
        paused: true,
        user: creator,
      }),
    ).resolves.toEqual({ success: true });

    expect(recovery.setMatchPaused).toHaveBeenCalledWith("match-1", true);
  });

  // Hasura types it Boolean!, but the hook can be posted to directly.
  it("takes only true or false for paused", async () => {
    const { controller, recovery } = setup(true);

    for (const paused of ["css_quit", 1, null, undefined]) {
      await expect(
        controller.setMatchPaused({
          match_id: "match-1",
          paused: paused as never,
          user,
        }),
      ).rejects.toThrow("paused must be true or false");
    }
    expect(recovery.setMatchPaused).not.toHaveBeenCalled();
  });

  it("offers setMatchPaused to every signed-in role through the api's hook", () => {
    const actions = yaml.load(
      readFileSync(join(METADATA, "actions.yaml"), "utf8"),
    ) as {
      actions: Array<{
        name: string;
        definition: { kind: string; handler: string };
        permissions?: Array<{ role: string }>;
      }>;
    };
    const action = actions.actions.find(
      (entry) => entry.name === "setMatchPaused",
    );

    expect(action?.definition).toEqual(
      expect.objectContaining({
        kind: "synchronous",
        handler: "{{HASURA_GRAPHQL_ACTIONS_HOOK}}",
      }),
    );
    expect(action?.permissions).toEqual([{ role: "user" }]);
    expect(
      readFileSync(join(METADATA, "actions.graphql"), "utf8").replace(
        /\s+/g,
        " ",
      ),
    ).toContain(
      "setMatchPaused( match_id: uuid! paused: Boolean! ): SuccessOutput",
    );
  });
});
