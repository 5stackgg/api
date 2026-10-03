import { ChatGifsService } from "./chat-gifs.service";

describe("ChatGifsService", () => {
  const KEY = "giphy-secret-key";

  let key: string | null;
  let hourly: string | null;
  let cache: Map<string, string>;
  let counters: Map<string, number>;

  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const postgres = {
    query: jest.fn(async (_sql: string, [name]: string[]) => {
      const value =
        name === "giphy_api_key"
          ? key
          : name === "giphy_hourly_limit"
            ? hourly
            : null;

      return value === null ? [] : [{ value }];
    }),
  };

  const redis = {
    get: jest.fn(async (name: string) => cache.get(name) ?? null),
    set: jest.fn(
      async (
        name: string,
        value: string,
        _mode?: string,
        _seconds?: number,
      ) => {
        cache.set(name, value);
        return "OK";
      },
    ),
    eval: jest.fn(async (_script: string, _keys: number, name: string) => {
      const count = (counters.get(name) ?? 0) + 1;
      counters.set(name, count);
      return count;
    }),
  };

  const giphy = (gifs: Array<Record<string, unknown>>, offset = 0) => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: gifs,
      pagination: { total_count: 100, count: gifs.length, offset },
    }),
  });

  const gif = (id: string) => ({
    id,
    title: `${id} title`,
    images: {
      original: {
        url: `https://media0.giphy.com/${id}.gif`,
        width: "480",
        height: "270",
      },
      fixed_width: {
        url: `https://media0.giphy.com/${id}-200.gif`,
        width: "200",
        height: "113",
      },
    },
  });

  let fetchMock: jest.SpyInstance;
  let service: ChatGifsService;

  beforeEach(() => {
    jest.clearAllMocks();
    key = KEY;
    cache = new Map();
    hourly = null;
    counters = new Map();
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(giphy([gif("abc123")]) as any);
    service = new ChatGifsService(
      logger as any,
      postgres as any,
      { getConnection: () => redis } as any,
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  const requested = () => new URL(fetchMock.mock.calls.at(-1)[0] as string);

  describe("a GIF in a message", () => {
    it("keeps the GIPHY id and the size to lay it out at", () => {
      expect(
        ChatGifsService.gif({ id: "abc123", width: 480, height: 270 }),
      ).toEqual({ id: "abc123", width: 480, height: 270 });
    });

    it("drops anything else the client sent along", () => {
      expect(
        ChatGifsService.gif({
          id: "abc123",
          width: 480,
          height: 270,
          url: "https://evil.example/pixel.gif",
        }),
      ).toEqual({ id: "abc123", width: 480, height: 270 });
    });

    it.each([
      [
        "a url for an id",
        { id: "https://evil.example/x.gif", width: 1, height: 1 },
      ],
      ["a path in the id", { id: "../abc", width: 1, height: 1 }],
      ["no id", { width: 1, height: 1 }],
      ["a fractional width", { id: "abc", width: 1.5, height: 1 }],
      ["no height", { id: "abc", width: 10 }],
      ["a zero width", { id: "abc", width: 0, height: 1 }],
      ["an absurd size", { id: "abc", width: 100000, height: 1 }],
      ["a string", "abc123"],
      ["null", null],
    ])("refuses %s", (_, raw) => {
      expect(ChatGifsService.gif(raw)).toBeNull();
    });
  });

  describe("search", () => {
    it("is off when no key is set", async () => {
      key = null;

      await expect(service.enabled()).resolves.toBe(false);
      await expect(service.search("1", "gg", 0)).resolves.toBe("disabled");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // The settings page reads "key set" back straight after saving.
    it("sees a key the moment it is added or removed", async () => {
      key = null;
      await expect(service.enabled()).resolves.toBe(false);

      key = KEY;
      await expect(service.enabled()).resolves.toBe(true);
      await expect(service.search("1", "gg", 0)).resolves.not.toBe("disabled");

      key = null;
      await expect(service.enabled()).resolves.toBe(false);
    });

    it("applies a new hourly allowance at once", async () => {
      await service.search("1", "first", 0);

      hourly = "1";

      await expect(service.search("2", "second", 0)).resolves.toBe("busy");
    });

    it("searches GIPHY with the operator's key and no rating filter", async () => {
      await service.search("1", "  clutch  ", 0);

      const url = requested();
      expect(url.origin + url.pathname).toBe(
        "https://api.giphy.com/v1/gifs/search",
      );
      expect(url.searchParams.get("api_key")).toBe(KEY);
      expect(url.searchParams.get("q")).toBe("clutch");
      expect(url.searchParams.has("rating")).toBe(false);
    });

    it("shows what is trending until something is typed", async () => {
      await service.search("1", "   ", 0);

      const url = requested();
      expect(url.pathname).toBe("/v1/gifs/trending");
      expect(url.searchParams.has("q")).toBe(false);
      expect(url.searchParams.has("rating")).toBe(false);
    });

    it("hands back ids and sizes, never a URL carrying the key", async () => {
      const page = await service.search("1", "gg", 0);

      expect(page).toEqual({
        results: [
          { id: "abc123", title: "abc123 title", width: 480, height: 270 },
        ],
        next: 1,
      });
      expect(JSON.stringify(page)).not.toContain(KEY);
    });

    it("pages on from where the last one ended", async () => {
      fetchMock.mockResolvedValue(giphy([gif("x1"), gif("x2")], 24) as any);

      const page = await service.search("1", "gg", 24);

      expect(requested().searchParams.get("offset")).toBe("24");
      expect(page).toMatchObject({ next: 26 });
    });

    it("stops paging at the end of the results", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [gif("last")],
          pagination: { total_count: 25, count: 1, offset: 24 },
        }),
      } as any);

      await expect(service.search("1", "gg", 24)).resolves.toMatchObject({
        next: null,
      });
    });

    it("skips a result it could not lay out", async () => {
      fetchMock.mockResolvedValue(
        giphy([gif("good"), { id: "bad", images: {} }]) as any,
      );

      const page = await service.search("1", "gg", 0);

      expect(page).toMatchObject({
        results: [expect.objectContaining({ id: "good" })],
      });
    });

    it("answers a repeat search from the cache", async () => {
      await service.search("1", "Clutch", 0);
      await service.search("2", "clutch", 0);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // The key is a shared quota, so one player cannot spend it for everyone.
    it("limits how often one player can search", async () => {
      counters.set("chat:gifs-rate:1", ChatGifsService.RATE_LIMIT);

      await expect(service.search("1", "gg", 0)).resolves.toBe("rate_limited");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says GIPHY is unavailable rather than throwing", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 429 } as any);

      await expect(service.search("1", "gg", 0)).resolves.toBe("unavailable");

      fetchMock.mockRejectedValue(new Error("socket hang up"));

      await expect(service.search("1", "rage", 0)).resolves.toBe("unavailable");
    });

    it.each([-1, 1.5, Number.NaN, 5000])(
      "starts from the top for an offset of %p",
      async (offset) => {
        await service.search("1", "gg", offset);

        expect(requested().searchParams.get("offset")).toBe("0");
      },
    );

    // One key serves the whole panel, and GIPHY's beta keys allow 100 calls an
    // hour between everyone.
    it("stops calling GIPHY once the panel's hourly allowance is spent", async () => {
      for (let i = 0; i < ChatGifsService.DEFAULT_HOURLY_LIMIT; i++) {
        await service.search(String(i), `term ${i}`, 0);
      }

      fetchMock.mockClear();

      await expect(service.search("99", "one more", 0)).resolves.toBe("busy");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stays under GIPHY's beta limit unless the operator says otherwise", async () => {
      expect(ChatGifsService.DEFAULT_HOURLY_LIMIT).toBeLessThan(100);

      hourly = "3";
      service = new ChatGifsService(
        logger as any,
        postgres as any,
        { getConnection: () => redis } as any,
      );

      for (let i = 0; i < 3; i++) {
        await service.search(String(i), `term ${i}`, 0);
      }

      await expect(service.search("9", "fourth", 0)).resolves.toBe("busy");
    });

    it("still answers from the cache when the allowance is spent", async () => {
      await service.search("1", "gg", 0);
      hourly = "0";
      service = new ChatGifsService(
        logger as any,
        postgres as any,
        { getConnection: () => redis } as any,
      );

      await expect(service.search("2", "gg", 0)).resolves.toMatchObject({
        results: [expect.objectContaining({ id: "abc123" })],
      });
    });

    it("keeps what is trending longer than a search", async () => {
      await service.search("1", "", 0);
      await service.search("1", "gg", 0);

      const ttls = Object.fromEntries(
        redis.set.mock.calls.map(([name, , , seconds]) => [name, seconds]),
      );

      expect(ttls["chat:gifs::0"]).toBe(60 * 60);
      expect(ttls["chat:gifs:gg:0"]).toBe(10 * 60);
    });

    it("caps what can be searched for", async () => {
      await service.search("1", "a".repeat(500), 0);

      expect(requested().searchParams.get("q")).toHaveLength(
        ChatGifsService.MAX_QUERY_LENGTH,
      );
    });
  });
});
