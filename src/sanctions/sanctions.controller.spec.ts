import { ForbiddenException, RequestMethod } from "@nestjs/common";
import { MatchServerMiddlewareMiddleware } from "src/matches/match-server-middleware/match-server-middleware.middleware";
import { SanctionsController } from "./sanctions.controller";
import { SanctionsModule } from "./sanctions.module";

describe("SanctionsController.syncServerSanctions", () => {
  const serverA = "11111111-1111-1111-1111-111111111111";
  const serverB = "22222222-2222-2222-2222-222222222222";

  const open = {
    restricted: false,
    version: "open",
    denied: [] as Array<string>,
    message: null as string | null,
  };

  let syncServerSanctions: jest.Mock;
  let forSync: jest.Mock;
  let controller: SanctionsController;

  beforeEach(() => {
    syncServerSanctions = jest.fn().mockResolvedValue([]);
    forSync = jest.fn().mockResolvedValue(open);
    controller = new SanctionsController(
      { syncServerSanctions } as any,
      { forSync } as any,
    );
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
    ).resolves.toEqual({ sanctions: [], access: open });

    expect(syncServerSanctions).toHaveBeenCalledWith(serverA, {
      steamIds: ["76561198000000001"],
      pluginVersion: "0.0.412",
      pluginRuntime: "swiftlys2",
    });
  });

  // Only well-formed ids reach the access check, the same filter the
  // sanctions lookup applies.
  it("checks access for the players the plugin reported", async () => {
    await controller.syncServerSanctions(serverA, {
      steam_ids: ["76561198000000001", "not-an-id", "76561198000000001"],
    });

    expect(forSync).toHaveBeenCalledWith(serverA, ["76561198000000001"]);
  });
});

describe("SanctionsController.serverAccessList", () => {
  it("returns the allowlist in the plugin's shape", async () => {
    const allowlist = jest.fn().mockResolvedValue({
      restricted: true,
      version: "abc",
      steamIds: ["76561198000000001"],
    });
    const controller = new SanctionsController(
      {} as any,
      {
        allowlist,
      } as any,
    );

    await expect(
      controller.serverAccessList("11111111-1111-1111-1111-111111111111"),
    ).resolves.toEqual({
      restricted: true,
      version: "abc",
      steam_ids: ["76561198000000001"],
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
    expect(forRoutes).toHaveBeenCalledWith(
      {
        path: "sanctions/server/:serverId",
        method: RequestMethod.POST,
      },
      {
        path: "sanctions/server/:serverId/access",
        method: RequestMethod.GET,
      },
    );
  });
});
