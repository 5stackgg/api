import { NotFoundException } from "@nestjs/common";
import { UtilityController } from "./utility.controller";

// Asking for its session is how a practice server says it is up, and the panel
// hands out a connect string straight after. So the server says where it can be
// reached on the same request, and one on the relay with no address yet is not
// up at all: the panel would give out a host and port that reaches nobody.
describe("UtilityController session", () => {
  const session = { session_id: "session-1", match_id: "match-1" };
  const request = { utilityServerId: "server-1" } as any;

  function make(running = true) {
    const calls: Array<string> = [];
    const practice = {
      reportSteamRelay: jest.fn(
        async (_: string, address: string | null, on: boolean | null) => {
          calls.push("relay");
          return !(on === true && !address);
        },
      ),
      sessionForServer: jest.fn(async () => (running ? session : null)),
      markReady: jest.fn(async () => {
        calls.push("ready");
      }),
      markMapLoaded: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new UtilityController(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      practice as any,
      {} as any,
    );
    return { controller, practice, calls };
  }

  it("records where the server is before calling it up", async () => {
    const { controller, practice, calls } = make();

    await controller.session(
      request,
      "de_mirage",
      "true",
      "[A:1:3653557264:51859]",
    );

    expect(practice.reportSteamRelay).toHaveBeenCalledWith(
      "server-1",
      "[A:1:3653557264:51859]",
      true,
    );
    expect(calls).toEqual(["relay", "ready"]);
  });

  it("calls a server up that says it is not on the relay", async () => {
    const { controller, practice } = make();

    await controller.session(request, "de_mirage", "false");

    expect(practice.reportSteamRelay).toHaveBeenCalledWith(
      "server-1",
      null,
      false,
    );
    expect(practice.markReady).toHaveBeenCalledWith("match-1");
  });

  it("does not call a server up that is on the relay with no address yet", async () => {
    const { controller, practice } = make();

    await expect(
      controller.session(request, "de_mirage", "true"),
    ).resolves.toBe(session);

    expect(practice.markReady).not.toHaveBeenCalled();
  });

  it("takes a plugin that says nothing about the relay at its word, as before", async () => {
    const { controller, practice } = make();

    await controller.session(request, "de_mirage");

    expect(practice.reportSteamRelay).toHaveBeenCalledWith(
      "server-1",
      null,
      null,
    );
    expect(practice.markReady).toHaveBeenCalledWith("match-1");
  });

  it("records where the server is even with no session running on it", async () => {
    const { controller, practice } = make(false);

    await expect(
      controller.session(request, "de_mirage", "false"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(practice.reportSteamRelay).toHaveBeenCalledWith(
      "server-1",
      null,
      false,
    );
  });
});
