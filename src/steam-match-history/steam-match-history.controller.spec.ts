import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { SteamMatchHistoryController } from "./steam-match-history.controller";

const SHARE_CODE = "CSGO-fhdrj-2EkxQ-8Tqrn-bmDBE-3VeuA";
const STEAM_ID = "76561197960500905";

describe("SteamMatchHistoryController.importSteamMatchShareCode", () => {
  let importShareCode: jest.Mock;
  let controller: SteamMatchHistoryController;

  beforeEach(() => {
    importShareCode = jest.fn(async () => ({ ok: true }));
    controller = new SteamMatchHistoryController(
      { importShareCode } as never,
      {} as never,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      {} as never,
      {} as never,
    );
  });

  it("imports under the caller's own steam id", async () => {
    await expect(
      controller.importSteamMatchShareCode({
        user: { steam_id: STEAM_ID } as never,
        share_code: SHARE_CODE,
      }),
    ).resolves.toEqual({ success: true, error: undefined });
    expect(importShareCode).toHaveBeenCalledWith(STEAM_ID, SHARE_CODE);
  });

  it("returns a refusal as success false with the reason for the toast", async () => {
    importShareCode.mockResolvedValueOnce({
      ok: false,
      error: "match already imported",
    });

    await expect(
      controller.importSteamMatchShareCode({
        user: { steam_id: STEAM_ID } as never,
        share_code: SHARE_CODE,
      }),
    ).resolves.toEqual({ success: false, error: "match already imported" });
  });

  it("refuses a caller without a steam id", async () => {
    await expect(
      controller.importSteamMatchShareCode({
        user: undefined as never,
        share_code: SHARE_CODE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(importShareCode).not.toHaveBeenCalled();
  });

  it("refuses an empty share code", async () => {
    await expect(
      controller.importSteamMatchShareCode({
        user: { steam_id: STEAM_ID } as never,
        share_code: "",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(importShareCode).not.toHaveBeenCalled();
  });
});
