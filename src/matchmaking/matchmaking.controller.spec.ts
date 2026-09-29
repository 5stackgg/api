import { Logger } from "@nestjs/common";
import { MatchmakingController } from "./matchmaking.controller";

describe("MatchmakingController.lobby_players", () => {
  let lobbies: {
    removeLobbyFromQueue: jest.Mock;
    removeLobbyDetails: jest.Mock;
  };
  let controller: MatchmakingController;

  beforeEach(() => {
    lobbies = {
      removeLobbyFromQueue: jest.fn(async () => false),
      removeLobbyDetails: jest.fn(async () => undefined),
    };
    controller = new MatchmakingController(
      new Logger("MatchmakingControllerTest"),
      lobbies as never,
    );
  });

  it("leaves the queue alone when an invite is sent or goes away", async () => {
    await controller.lobby_players({
      op: "INSERT",
      old: {},
      new: { lobby_id: "lobby", steam_id: "2", status: "Invited" },
    });
    await controller.lobby_players({
      op: "DELETE",
      old: { lobby_id: "lobby", steam_id: "2", status: "Invited" },
      new: {},
    });

    expect(lobbies.removeLobbyFromQueue).not.toHaveBeenCalled();
  });

  it("pulls the lobby and the player out of the queue when a member leaves", async () => {
    await controller.lobby_players({
      op: "DELETE",
      old: { lobby_id: "lobby", steam_id: "2", status: "Accepted" },
      new: {},
    });

    expect(lobbies.removeLobbyFromQueue).toHaveBeenCalledWith("lobby");
    expect(lobbies.removeLobbyFromQueue).toHaveBeenCalledWith("2");
  });

  it("pulls the lobby out of the queue when an invite is accepted", async () => {
    await controller.lobby_players({
      op: "UPDATE",
      old: { lobby_id: "lobby", steam_id: "2", status: "Invited" },
      new: { lobby_id: "lobby", steam_id: "2", status: "Accepted" },
    });

    expect(lobbies.removeLobbyFromQueue).toHaveBeenCalledWith("lobby");
  });
});
