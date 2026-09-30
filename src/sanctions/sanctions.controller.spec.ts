import { ForbiddenException, RequestMethod } from "@nestjs/common";
import { MatchServerMiddlewareMiddleware } from "src/matches/match-server-middleware/match-server-middleware.middleware";
import { SanctionsController } from "./sanctions.controller";
import { SanctionsModule } from "./sanctions.module";

describe("SanctionsController.syncServerSanctions", () => {
  const serverA = "11111111-1111-1111-1111-111111111111";
  const serverB = "22222222-2222-2222-2222-222222222222";

  let syncServerSanctions: jest.Mock;
  let controller: SanctionsController;

  beforeEach(() => {
    syncServerSanctions = jest.fn().mockResolvedValue([]);
    controller = new SanctionsController({ syncServerSanctions } as any);
  });

  // The middleware authenticates the body's serverId in preference to the
  // path's, so a server could otherwise prove itself as A and write B.
  it("refuses a body serverId that is not the server in the path", async () => {
    await expect(
      controller.syncServerSanctions(serverB, {
        serverId: serverA,
        plugin_version: "9.9.9",
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(syncServerSanctions).not.toHaveBeenCalled();
  });

  it("syncs the server in the path", async () => {
    await expect(
      controller.syncServerSanctions(serverA, {
        steam_ids: ["76561198000000001"],
        plugin_version: "0.0.412",
        plugin_runtime: "swiftlys2",
      }),
    ).resolves.toEqual({ sanctions: [] });

    expect(syncServerSanctions).toHaveBeenCalledWith(serverA, {
      steamIds: ["76561198000000001"],
      pluginVersion: "0.0.412",
      pluginRuntime: "swiftlys2",
    });
  });
});

describe("SanctionsModule", () => {
  // Without the middleware on this exact route and method the endpoint would
  // answer anyone and record anyone's heartbeat.
  it("puts the sync route behind the game server's api password", () => {
    const forRoutes = jest.fn();
    const apply = jest.fn(() => ({ forRoutes }));

    new SanctionsModule().configure({ apply } as any);

    expect(apply).toHaveBeenCalledWith(MatchServerMiddlewareMiddleware);
    expect(forRoutes).toHaveBeenCalledWith({
      path: "sanctions/server/:serverId",
      method: RequestMethod.POST,
    });
  });
});
