import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ExtensionController } from "./extension.controller";

const ROOM = "1-c0d53305-38d8-4d84-9f40-cd0a6032e5bd";
const SIGNED = `https://demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com/cs2/${ROOM}-1-1.dem.zst?X-Amz-Expires=299`;
const USER = { steam_id: "76561198000000001", name: "player", role: "user" };

describe("ExtensionController", () => {
  function make({ faceit = true, valve = true } = {}) {
    const extension = {
      imports: jest.fn(async () => ({ faceit, valve })),
      faceitAccount: jest.fn(async () => ({
        player_id: "ac71ba3c-d3d4-45e7-8be2-26aa3986867d",
        nickname: "LukePOLO",
      })),
      queueFaceitDemo: jest.fn(async () => ({ state: "queued" })),
      queueShareCodes: jest.fn(async () => ({})),
    };
    return {
      controller: new ExtensionController(extension as never),
      extension,
    };
  }

  const as = (user: unknown) => ({ user }) as never;

  it("treats a request without a 5Stack session as logged out", async () => {
    const { controller } = make();

    await expect(controller.me(as(undefined))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("tells the extension what this panel lets it import", async () => {
    const { controller } = make({ valve: false });

    await expect(controller.me(as(USER))).resolves.toEqual({
      steam_id: USER.steam_id,
      name: USER.name,
      avatar_url: null,
      role: "user",
      imports: { faceit: true, valve: false, anyone: false },
      faceit: {
        player_id: "ac71ba3c-d3d4-45e7-8be2-26aa3986867d",
        nickname: "LukePOLO",
      },
    });
  });

  it("logs the player out of 5Stack by ending the session", async () => {
    const { controller } = make();
    const destroy = jest.fn((done: (error?: Error) => void) => done());

    await expect(
      controller.logout({ user: USER, session: { destroy } } as never),
    ).resolves.toEqual({ success: true });
    expect(destroy).toHaveBeenCalled();
  });

  it("refuses a FACEIT import when the panel has FACEIT imports off", async () => {
    const { controller, extension } = make({ faceit: false });

    await expect(
      controller.importFaceit(as(USER), { match_id: ROOM, url: SIGNED }),
    ).rejects.toThrow(ForbiddenException);
    expect(extension.queueFaceitDemo).not.toHaveBeenCalled();
  });

  it("queues a FACEIT demo for the signed-in player", async () => {
    const { controller, extension } = make();

    await controller.importFaceit(as(USER), { match_id: ROOM, url: SIGNED });

    expect(extension.queueFaceitDemo).toHaveBeenCalledWith(USER, {
      matchId: ROOM,
      url: SIGNED,
    });
  });

  it("caps how many share codes one request may send", async () => {
    const { controller } = make();

    await expect(
      controller.importValve(as(USER), {
        share_codes: Array.from({ length: 21 }, () => "CSGO-a"),
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
