import { PlaycastRelayService } from "./playcast-relay.service";

const RELAY = "https://relay.example.com";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOSTNAME = "playcast.acme.gg";
const WORKER = `https://${HOSTNAME}`;
const API = "https://api.cloudflare.com/client/v4";

describe("PlaycastRelayService", () => {
  let hasura: { mutation: jest.Mock };
  let service: PlaycastRelayService;
  let calls: Array<{ url: string; init: RequestInit }>;
  let health: { ok?: boolean; origin?: string } | null;
  let zones: Record<string, string>;
  const realFetch = global.fetch;

  beforeEach(() => {
    hasura = { mutation: jest.fn(async (): Promise<void> => undefined) };
    service = new PlaycastRelayService(
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
      hasura as any,
      { get: () => ({ relayDomain: RELAY }) } as any,
    );
    calls = [];
    health = { ok: true, origin: RELAY };
    zones = { "acme.gg": "zone-acme" };

    global.fetch = jest.fn(async (input: any, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });

      if (url.endsWith("/health")) {
        return new Response(JSON.stringify(health), { status: 200 });
      }
      if (url.startsWith(`${API}/zones?`)) {
        const name = new URL(url).searchParams.get("name")!;
        return new Response(
          JSON.stringify({
            success: true,
            result: zones[name] ? [{ id: zones[name] }] : [],
          }),
        );
      }
      return new Response(JSON.stringify({ success: true, result: {} }));
    }) as any;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  const savedSetting = () =>
    hasura.mutation.mock.calls.find(([arg]) => arg.insert_settings_one)?.[0]
      .insert_settings_one.__args.object;

  const callTo = (method: string, suffix: string) =>
    calls.find(
      (call) => call.init.method === method && call.url.endsWith(suffix),
    );

  describe("deploy", () => {
    it("uploads the worker pointed at this panel's relay, on the given hostname", async () => {
      expect(await service.deploy(ACCOUNT, "cf-token", HOSTNAME)).toEqual({
        url: WORKER,
        ready: true,
      });

      const upload = callTo("PUT", "/workers/scripts/5stack-playcast-relay")!;
      expect(upload.url).toBe(
        `${API}/accounts/${ACCOUNT}/workers/scripts/5stack-playcast-relay`,
      );
      const form = upload.init.body as FormData;
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
      expect(metadata.main_module).toBe("worker.js");
      expect(metadata.bindings).toEqual([
        { type: "plain_text", name: "ORIGIN", text: RELAY },
      ]);
      expect(await (form.get("worker.js") as Blob).text()).toContain(
        "X-Broadcast-Token",
      );
      expect((upload.init.headers as any).Authorization).toBe(
        "Bearer cf-token",
      );

      const domain = callTo("PUT", `/accounts/${ACCOUNT}/workers/domains`)!;
      expect(JSON.parse(domain.init.body as string)).toEqual({
        hostname: HOSTNAME,
        service: "5stack-playcast-relay",
        zone_id: "zone-acme",
      });

      expect(savedSetting()).toEqual({
        name: "playcast_relay_url",
        value: WORKER,
      });
    });

    it("reports a worker whose certificate is still being issued, without switching viewers to it", async () => {
      (PlaycastRelayService as any).LIVE_TIMEOUT_MS = 0;
      health = null;

      try {
        expect(await service.deploy(ACCOUNT, "cf-token", HOSTNAME)).toEqual({
          url: WORKER,
          ready: false,
        });
      } finally {
        (PlaycastRelayService as any).LIVE_TIMEOUT_MS = 20_000;
      }

      expect(callTo("PUT", "/workers/domains")).toBeDefined();
      expect(savedSetting()).toBeUndefined();
    });

    it("finds the zone for a hostname nested under it", async () => {
      await service.deploy(ACCOUNT, "cf-token", "edge.playcast.acme.gg");

      const domain = callTo("PUT", "/workers/domains")!;
      expect(JSON.parse(domain.init.body as string).zone_id).toBe("zone-acme");
    });

    it("refuses a hostname that is not on a domain in the account, before deploying", async () => {
      await expect(
        service.deploy(ACCOUNT, "cf-token", "playcast.elsewhere.com"),
      ).rejects.toThrow("not on a domain in this Cloudflare account");

      expect(callTo("PUT", "/workers/scripts/5stack-playcast-relay")).toBe(
        undefined,
      );
      expect(savedSetting()).toBeUndefined();
    });

    it("refuses workers.dev, where Cloudflare would not cache anything", async () => {
      await expect(
        service.deploy(ACCOUNT, "cf-token", "5stack.acme.workers.dev"),
      ).rejects.toThrow("workers.dev");
      expect(calls).toHaveLength(0);
    });

    it("never stores the api token", async () => {
      await service.deploy(ACCOUNT, "cf-token", HOSTNAME);

      expect(JSON.stringify(hasura.mutation.mock.calls)).not.toContain(
        "cf-token",
      );
    });

    it("rejects something that is not an account id before calling Cloudflare", async () => {
      await expect(
        service.deploy("../../zones", "cf-token", HOSTNAME),
      ).rejects.toThrow("account ID");
      expect(calls).toHaveLength(0);
    });

    it("rejects something that is not a hostname before calling Cloudflare", async () => {
      await expect(
        service.deploy(ACCOUNT, "cf-token", "https://x/y"),
      ).rejects.toThrow("hostname");
      expect(calls).toHaveLength(0);
    });

    it("passes on why Cloudflare refused", async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ message: "Authentication error" }],
            }),
            { status: 403 },
          ),
      );

      await expect(service.deploy(ACCOUNT, "bad", HOSTNAME)).rejects.toThrow(
        "Authentication error",
      );
      expect(savedSetting()).toBeUndefined();
    });
  });

  describe("use", () => {
    it("saves a worker that fronts this panel", async () => {
      expect(await service.use(`${WORKER}/`)).toBe(WORKER);
      expect(savedSetting()).toEqual({
        name: "playcast_relay_url",
        value: WORKER,
      });
    });

    it("refuses a worker that fronts another relay", async () => {
      health = { ok: true, origin: "https://relay.someone-else.com" };

      await expect(service.use(WORKER)).rejects.toThrow("not this panel");
      expect(savedSetting()).toBeUndefined();
    });

    it("refuses a url that is not a relay worker", async () => {
      health = null;

      await expect(service.use(WORKER)).rejects.toThrow(
        "No 5stack playcast relay worker",
      );
    });

    it("refuses a workers.dev address", async () => {
      await expect(
        service.use("https://5stack-playcast-relay.acme.workers.dev"),
      ).rejects.toThrow("workers.dev");
      expect(savedSetting()).toBeUndefined();
    });

    it("refuses a plain http url", async () => {
      await expect(service.use("http://example.com")).rejects.toThrow(
        "https://",
      );
    });

    it.each([
      'https://playcast.acme.gg/"; quit',
      "https://playcast.acme.gg/path",
      "https://playcast.acme.gg?x=1",
      "https://user:pass@playcast.acme.gg",
    ])("refuses anything but a bare https origin: %s", async (url) => {
      await expect(service.use(url)).rejects.toThrow();
      expect(calls).toHaveLength(0);
      expect(savedSetting()).toBeUndefined();
    });

    it("does not follow a redirect from the health check", async () => {
      await service.use(WORKER);

      const check = calls.find((call) => call.url.endsWith("/health"))!;
      expect(check.init.redirect).toBe("manual");
    });

    it("goes back to the built-in relay when given no url", async () => {
      expect(await service.use(null)).toBeNull();
      expect(hasura.mutation).toHaveBeenCalledWith(
        expect.objectContaining({
          delete_settings_by_pk: expect.objectContaining({
            __args: { name: "playcast_relay_url" },
          }),
        }),
      );
    });
  });
});
