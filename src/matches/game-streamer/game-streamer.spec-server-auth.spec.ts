jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import { GameStreamerService } from "./game-streamer.service";

describe("GameStreamerService — spec-server token", () => {
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let fetchMock: jest.SpyInstance;

  const makeService = (encSecret: string) =>
    new GameStreamerService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      {
        get: (key: string) => {
          if (key === "gameServers") {
            return { namespace: "test", gameStreamerImage: "game-streamer" };
          }
          if (key === "app") {
            return { encSecret };
          }
          return {} as any;
        },
      } as any,
      hasura as any,
      {} as any,
      { getConnection: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      { resolveEnabled: jest.fn(), bundleUrl: jest.fn() } as any,
    );

  let service: GameStreamerService;

  const podEnv = (
    target: GameStreamerService,
    jobName: string,
    mode = "live",
  ): Record<string, string> => {
    const job = (target as any).buildJobSpec(
      jobName,
      "match-1",
      mode,
      "node-a",
      [],
    );
    return Object.fromEntries(
      job.spec.template.spec.containers[0].env.map(
        (entry: { name: string; value: string }) => [entry.name, entry.value],
      ),
    );
  };

  const podToken = (jobName: string) =>
    podEnv(service, jobName).SPEC_SERVER_TOKEN;

  const sentHeaders = (call = 0): Record<string, string> =>
    (fetchMock.mock.calls[call][1]?.headers ?? {}) as Record<string, string>;

  beforeEach(() => {
    hasura = { query: jest.fn(), mutation: jest.fn().mockResolvedValue({}) };
    service = makeService("enc-secret");
    fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
      text: async () => "",
    } as any);
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe("the pod spec", () => {
    it.each([
      "live",
      "demo",
      "batch-highlights",
      "nade-previews",
      "warm-shaders",
      "create-clips",
    ])("gives a %s pod a SPEC_SERVER_TOKEN of its own", (mode) => {
      const token = podEnv(service, "gs-job-1", mode).SPEC_SERVER_TOKEN;

      expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      expect(podEnv(service, "gs-job-2", mode).SPEC_SERVER_TOKEN).not.toBe(
        token,
      );
    });

    it("keys the token to the api's secret", () => {
      expect(
        podEnv(makeService("other-secret"), "gs-job-1").SPEC_SERVER_TOKEN,
      ).not.toBe(podToken("gs-job-1"));
    });
  });

  describe("calls into a live pod", () => {
    it("carry the token of the pod the stream row points at", async () => {
      hasura.query.mockResolvedValue({
        match_streams: [{ k8s_service_name: "gs-live-match-a" }],
      });

      await service.specClick("match-b", "left");

      expect(fetchMock.mock.calls[0][0]).toContain("gs-live-match-a.");
      expect(sentHeaders().Authorization).toBe(
        `Bearer ${podToken(GameStreamerService.GetLiveJobId("match-a"))}`,
      );
      expect(sentHeaders()["Content-Type"]).toBe("application/json");
    });

    it("carry the token when reading the live spec state", async () => {
      hasura.query.mockResolvedValue({ match_streams: [] });

      await service.getLiveSpecState("match-1");

      expect(fetchMock.mock.calls[0][0]).toContain("/demo/state");
      expect(sentHeaders().Authorization).toBe(
        `Bearer ${podToken(GameStreamerService.GetLiveJobId("match-1"))}`,
      );
    });

    it("carry the token when switching the pod to another match", async () => {
      hasura.query
        .mockResolvedValueOnce({
          match_streams: [
            {
              id: "stream-1",
              is_live: true,
              autodirector: true,
              mode: "live",
              k8s_service_name: "gs-live-match-a",
            },
          ],
        })
        .mockResolvedValueOnce({ match_streams: [] })
        .mockResolvedValueOnce({
          matches_by_pk: {
            id: "match-b",
            status: "Live",
            password: "pw",
            server: { connected: true, enabled: true },
          },
        })
        .mockResolvedValueOnce({
          match_streams: [{ k8s_service_name: "gs-live-match-a" }],
        });
      jest.spyOn(service as any, "readUsePlaycast").mockResolvedValue(false);
      jest
        .spyOn(service as any, "buildConnectEnv")
        .mockResolvedValue([{ name: "CONNECT_ADDR", value: "1.2.3.4:27015" }]);

      await service.switchLive("match-a", "match-b", "live");

      expect(fetchMock.mock.calls[0][0]).toContain("/spec/switch-match");
      expect(sentHeaders().Authorization).toBe(
        `Bearer ${podToken(GameStreamerService.GetLiveJobId("match-a"))}`,
      );
    });
  });

  describe("calls into a demo pod", () => {
    const sessionToken = () =>
      podToken(GameStreamerService.GetDemoJobIdForSession("session-1"));

    beforeEach(() => {
      jest
        .spyOn(service as any, "findDemoSessionCached")
        .mockResolvedValue({ id: "session-1" });
      jest
        .spyOn(service as any, "bumpDemoSessionActivityThrottled")
        .mockImplementation(() => undefined);
    });

    it("carry the session pod's token on a control", async () => {
      await service.demoControl("map-1", "76561198000000000", "pause");

      expect(sentHeaders().Authorization).toBe(`Bearer ${sessionToken()}`);
    });

    it("carry the session pod's token on a state read", async () => {
      await service.demoControl("map-1", "76561198000000000", "state");

      expect(fetchMock.mock.calls[0][1].method).toBe("GET");
      expect(sentHeaders().Authorization).toBe(`Bearer ${sessionToken()}`);
    });

    it("carry the session pod's token on a clip render", async () => {
      await service.dispatchClipRenderToPod("session-1", {
        job_id: "job-1",
        token: "render-token",
        api_base: "http://api.test",
        segments: [{ start_tick: 1, end_tick: 2 }],
        output_dims: "1920x1080",
        output_fps: 60,
      });

      expect(fetchMock.mock.calls[0][0]).toContain("/demo/render-clip");
      expect(sentHeaders().Authorization).toBe(`Bearer ${sessionToken()}`);
    });
  });
});
