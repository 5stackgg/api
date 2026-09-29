jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { MatchesController } from "./matches.controller";
import { GameStreamerService } from "./game-streamer/game-streamer.service";

// Positional, in constructor order; anything a test does not reach stays {}.
const controllerWith = (deps: {
  hasura?: unknown;
  matchAssistant?: unknown;
  gameStreamer?: unknown;
  clips?: unknown;
  gameModes?: unknown;
}) => {
  const args: any[] = Array.from({ length: 30 }, () => ({}));

  args[1] = deps.hasura ?? {};
  args[3] = { get: jest.fn(() => ({})) };
  args[5] = deps.matchAssistant ?? {};
  args[21] = deps.gameStreamer ?? {};
  args[23] = deps.clips ?? {};
  args[29] = deps.gameModes ?? {};

  return new (MatchesController as any)(...args) as MatchesController;
};

describe("MatchesController", () => {
  let controller: MatchesController;
  let matchAssistant: {
    isOrganizer: jest.Mock;
    rebootOnDemandServer: jest.Mock;
  };
  let hasura: { query: jest.Mock };
  let notifications: { send: jest.Mock };

  beforeEach(() => {
    matchAssistant = {
      isOrganizer: jest.fn(),
      rebootOnDemandServer: jest.fn(),
    };
    hasura = { query: jest.fn() };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };

    controller = new MatchesController(
      {} as any,
      hasura as any,
      {} as any,
      {
        get: jest.fn(() => ({ webDomain: "https://5stack.test" })),
      } as any,
      {} as any,
      matchAssistant as any,
      {} as any,
      {} as any,
      {} as any,
      notifications as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it("rejects non-organizers", async () => {
    matchAssistant.isOrganizer.mockResolvedValue(false);

    await expect(
      controller.rebootMatchServer({
        match_id: "match-1",
        user: { steam_id: "user-1" } as any,
      }),
    ).rejects.toThrow("you are not a match organizer");

    expect(matchAssistant.rebootOnDemandServer).not.toHaveBeenCalled();
  });

  it("initiates a reboot for organizers", async () => {
    matchAssistant.isOrganizer.mockResolvedValue(true);
    matchAssistant.rebootOnDemandServer.mockResolvedValue(undefined);

    await expect(
      controller.rebootMatchServer({
        match_id: "match-1",
        user: { steam_id: "user-1" } as any,
      }),
    ).resolves.toEqual({ success: true });

    expect(matchAssistant.rebootOnDemandServer).toHaveBeenCalledWith("match-1");
  });

  describe("callForOrganizer", () => {
    const matchId = "00000000-0000-0000-0000-000000000001";

    const callForOrganizer = () =>
      controller.callForOrganizer({
        match_id: matchId,
        user: { steam_id: "76561198000000001", name: "signed-in-as" } as any,
      });

    const respond = (
      match: Record<string, boolean>,
      player: { name: string } | null = { name: "keith" },
    ) =>
      hasura.query.mockResolvedValue({
        matches_by_pk: match,
        players_by_pk: player,
      });

    const sent = () => {
      const [type, notification] = notifications.send.mock.calls[0];
      return { type, ...notification };
    };

    beforeEach(() => {
      respond({ is_in_lineup: true, requested_organizer: false });
    });

    it("names the requester without linking them", async () => {
      respond(
        { is_in_lineup: true, requested_organizer: false },
        { name: "<b>keith</b>" },
      );

      await callForOrganizer();

      const notification = sent();
      expect(notification.type).toBe("MatchSupport");
      expect(notification.message).toContain(
        "<b>&lt;b&gt;keith&lt;/b&gt;</b> requested assistance in match",
      );
      expect(notification.message.match(/href="([^"]+)"/)?.[1]).toBe(
        `https://5stack.test/matches/${matchId}`,
      );
    });

    it("uses the current name rather than the one the session signed in with", async () => {
      await callForOrganizer();

      expect(sent().message).toContain("<b>keith</b> requested assistance");
      expect(sent().message).not.toContain("signed-in-as");
    });

    it("falls back to the steam id when the player row is missing", async () => {
      respond({ is_in_lineup: true, requested_organizer: false }, null);

      await callForOrganizer();

      expect(sent().message).toContain(
        "<b>76561198000000001</b> requested assistance",
      );
    });

    it("titles the notification without the old typo", async () => {
      await callForOrganizer();

      expect(sent().title).toBe("Match Assistance Required");
      expect(sent().message).not.toContain("Assistanced");
    });

    it("rejects someone who is not playing in the match", async () => {
      respond({ is_in_lineup: false, requested_organizer: false });

      await expect(callForOrganizer()).rejects.toThrow(
        "only players in this match can contact support",
      );
      expect(notifications.send).not.toHaveBeenCalled();
    });

    it("does not ask twice while a request is still open", async () => {
      respond({ is_in_lineup: true, requested_organizer: true });

      await expect(callForOrganizer()).resolves.toEqual({
        success: true,
      });
      expect(notifications.send).not.toHaveBeenCalled();
    });
  });

  describe("current match", () => {
    const lineup = (id: string) => ({
      id,
      name: id,
      team: null as null,
      coach_steam_id: null as null,
      lineup_players: [] as unknown[],
    });

    const payload = async () => {
      const hasura = {
        query: jest.fn(async (query: Record<string, any>) => {
          if (query.servers_by_pk) {
            return { servers_by_pk: { current_match: { id: "match-1" } } };
          }

          if (query.matches_by_pk) {
            return {
              matches_by_pk: {
                id: "match-1",
                status: "Live",
                is_tournament_match: false,
                draft_games: [] as unknown[],
                server: { server_region: { is_lan: false } },
                options: { type: "Competitive", game_mode_id: null as null },
                match_maps: [] as unknown[],
                lineup_1: lineup("lineup-1"),
                lineup_2: lineup("lineup-2"),
                tournament_brackets: [] as unknown[],
              },
            };
          }

          if (query.match_type_cfgs) {
            return { match_type_cfgs: [] as unknown[] };
          }

          return { settings_by_pk: null as null };
        }),
      };

      const json = jest.fn();
      const response = { status: jest.fn(() => ({ json })) };

      await controllerWith({
        hasura,
        gameModes: {
          resolveForServer: jest.fn(async (): Promise<null> => null),
          pluginCfgLayers: jest.fn(async () => [] as unknown[]),
        },
      }).getMatchDetails(
        { params: { serverId: "server-1" }, headers: {} } as any,
        response as any,
      );

      expect(response.status).toHaveBeenCalledWith(200);

      return json.mock.calls[0][0];
    };

    it("advertises team chat relay as a JSON boolean", async () => {
      // the plugin only relays say_team when this is present, and its
      // deserializer rejects the whole payload if it arrives as a string
      expect((await payload()).relay_team_chat).toBe(true);
    });
  });

  describe("clip output", () => {
    let clips: {
      buildPresetSpec: jest.Mock;
      createClipRender: jest.Mock;
      queueClipFromPreset: jest.Mock;
    };
    let controller: MatchesController;

    const streamer = { role: "streamer", steam_id: "76561198000000001" };
    const admin = { role: "administrator", steam_id: "76561198000000002" };

    // Rows as a non-administrator's session can read them: `public.` only.
    const operatorSettings: Record<string, string> = {
      "public.clip_fps": "30",
      "public.clip_resolution": "720p",
    };

    const preset = (extra: Record<string, unknown> = {}) =>
      controller.createClipFromPreset({
        match_map_id: "map-1",
        target_steam_id: "76561198000000009",
        preset: "multikills",
        user: streamer as any,
        ...extra,
      } as any);

    const presetOutput = () => clips.buildPresetSpec.mock.calls[0][3];

    beforeEach(() => {
      const hasura = {
        query: jest.fn(
          async (query: { settings_by_pk?: { __args: { name: string } } }) => {
            const value = operatorSettings[query.settings_by_pk?.__args.name];
            return { settings_by_pk: value === undefined ? null : { value } };
          },
        ),
      };

      const gameStreamer = new GameStreamerService(
        { warn: jest.fn() } as any,
        { get: jest.fn(() => ({})) } as any,
        hasura as any,
        {} as any,
        { getConnection: jest.fn() } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      clips = {
        buildPresetSpec: jest.fn(async () => ({ match_map_id: "map-1" })),
        createClipRender: jest.fn(async () => ({ jobId: "job-1" })),
        queueClipFromPreset: jest.fn(async () => ({ jobId: "job-2" })),
      };

      controller = controllerWith({ hasura, gameStreamer, clips });
    });

    it("renders a preset at the operator's settings when the client sends none", async () => {
      await preset();

      expect(presetOutput()).toEqual({ resolution: "720p", fps: 30 });
    });

    it("keeps the operator's fps when the client sends its own", async () => {
      await preset({ fps: 60 });

      expect(presetOutput()).toEqual({ resolution: "720p", fps: 30 });
    });

    it("honours a resolution picked in the render dialog", async () => {
      await preset({ resolution: "1080p", fps: 60 });

      expect(presetOutput()).toEqual({ resolution: "1080p", fps: 30 });
    });

    it("falls back to the operator's resolution for one the dialog does not offer", async () => {
      await preset({ resolution: "4k" });

      expect(presetOutput()).toEqual({ resolution: "720p", fps: 30 });
    });

    it("queues a highlight at the operator's fps", async () => {
      await controller.queueClipFromPreset({
        match_map_id: "map-1",
        target_steam_id: "76561198000000009",
        preset: "best_round",
        resolution: "1080p",
        fps: 60,
        user: admin,
      } as any);

      expect(clips.queueClipFromPreset.mock.calls[0][1].output).toEqual({
        resolution: "1080p",
        fps: 30,
      });
    });

    it("renders an edited clip at the operator's fps", async () => {
      await controller.createClipRender({
        spec: {
          match_map_id: "map-1",
          segments: [{ start_tick: 1, end_tick: 2 }],
          output: { format: "mp4", resolution: "1080p", fps: 60 },
          destination: "library",
        },
        user: streamer as any,
      });

      expect(clips.createClipRender.mock.calls[0][1].output).toEqual({
        format: "mp4",
        resolution: "1080p",
        fps: 30,
      });
    });
  });
});
