import { GUARDS_METADATA } from "@nestjs/common/constants";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { FileManagerController } from "./file-manager.controller";

describe("FileManagerController uploads", () => {
  const service = { uploadFile: jest.fn().mockResolvedValue({ ok: true }) };
  const controller = new FileManagerController(service as never);
  const file = { buffer: Buffer.from("plugin") } as Express.Multer.File;
  const signedIn = { user: { steam_id: "76561198000000001" } } as never;

  beforeEach(() => {
    service.uploadFile.mockClear();
  });

  it.each(["uploadFileToServer", "uploadFileToCustomPlugins"])(
    "%s needs a signed-in session before the file is read",
    (handler) => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        (FileManagerController.prototype as any)[handler],
      );
      expect(guards).toContain(SteamGuard);
    },
  );

  it("uploads to a server as the signed-in player", async () => {
    await (controller.uploadFileToServer as any)(
      signedIn,
      "node-1",
      "server-1",
      file,
      "/csgo/addons/x.dll",
    );

    expect(service.uploadFile).toHaveBeenCalledWith(
      "76561198000000001",
      "node-1",
      "server-1",
      "/csgo/addons/x.dll",
      file.buffer,
    );
  });

  it("uploads a custom plugin as the signed-in player", async () => {
    await (controller.uploadFileToCustomPlugins as any)(
      signedIn,
      "node-1",
      file,
      "/plugins/x.dll",
    );

    expect(service.uploadFile).toHaveBeenCalledWith(
      "76561198000000001",
      "node-1",
      undefined,
      "/plugins/x.dll",
      file.buffer,
    );
  });
});
