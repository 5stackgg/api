import { BadRequestException } from "@nestjs/common";
import { UtilityController } from "./utility.controller";

const PLAYER = "76561198000000001";
const STRANGER = "76561198000000002";

describe("UtilityController playbooks", () => {
  const context = {
    serverId: "server",
    matchId: "match",
    mapName: "de_mirage",
    lineupSteamIds: [PLAYER],
  };
  const book = { id: "book", name: "A execute", map_name: "de_mirage" };

  function make() {
    const playbooks = { forPlayer: jest.fn().mockResolvedValue([book]) };
    const controller = new UtilityController(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {} as any,
      {
        isLibraryEnabled: jest.fn().mockResolvedValue(true),
        serverContext: jest.fn().mockResolvedValue(context),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      playbooks as any,
    );

    return { controller, playbooks };
  }

  const request = { utilityServerId: "server" } as any;

  it("lists a hosted player's executes for the map the server is on", async () => {
    const { controller, playbooks } = make();

    await expect(controller.playbooksFor(request, PLAYER)).resolves.toEqual({
      map_name: "de_mirage",
      playbooks: [book],
    });
    expect(playbooks.forPlayer).toHaveBeenCalledWith("de_mirage", PLAYER);
  });

  it("reads nothing for somebody the server is not hosting", async () => {
    const { controller, playbooks } = make();

    await expect(controller.playbooksFor(request, STRANGER)).rejects.toThrow(
      BadRequestException,
    );
    expect(playbooks.forPlayer).not.toHaveBeenCalled();
  });
});
