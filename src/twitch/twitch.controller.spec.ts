import { TwitchController } from "./twitch.controller";

// The viewer is what the anti-ghosting filter keys on: a read that stopped
// passing it would quietly show every viewer what a guest sees.
describe("TwitchController", () => {
  const VIEWER = "76561198000000009";
  const PLAYER = "76561198000000001";
  const MATCH = "00000000-0000-4000-8000-000000000000";

  const accounts = {
    me: jest.fn(async () => ({ enabled: true, account: null as null })),
    unlink: jest.fn(async (): Promise<void> => undefined),
    liveSteamIds: jest.fn(async () => [PLAYER]),
    player: jest.fn(async () => ({ steam_id: PLAYER })),
    matchStreams: jest.fn(async (): Promise<Array<unknown>> => []),
  };

  const controller = new TwitchController(accounts as any);

  const signedIn = { user: { steam_id: VIEWER } } as any;
  const guest = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["a signed-in player", signedIn, VIEWER],
    ["a guest", guest, undefined],
  ])(
    "passes %s through as the viewer of every read",
    async (_case, request, viewer) => {
      expect(await controller.live(request)).toEqual({ steam_ids: [PLAYER] });
      await controller.player(request, PLAYER);
      expect(await controller.matchStreams(request, MATCH)).toEqual({
        streams: [],
      });

      expect(accounts.liveSteamIds).toHaveBeenCalledWith(viewer);
      expect(accounts.player).toHaveBeenCalledWith(PLAYER, viewer);
      expect(accounts.matchStreams).toHaveBeenCalledWith(MATCH, viewer);
    },
  );

  it("answers 404 for a player it will not show", async () => {
    accounts.player.mockResolvedValueOnce(null);

    await expect(controller.player(signedIn, PLAYER)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("only ever reads and unlinks the signed-in player's own account", async () => {
    await controller.me(signedIn);
    expect(await controller.unlink(signedIn)).toEqual({ success: true });

    expect(accounts.me).toHaveBeenCalledWith(VIEWER);
    expect(accounts.unlink).toHaveBeenCalledWith(VIEWER);
  });
});
