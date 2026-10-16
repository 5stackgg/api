import { BadRequestException, HttpException } from "@nestjs/common";
import { ExtensionService } from "./extension.service";

const ROOM = "1-c0d53305-38d8-4d84-9f40-cd0a6032e5bd";
const RESOURCE = `https://demos-europe-central.backblaze.faceit-cdn.net/cs2/${ROOM}-1-1.dem.zst`;
const RESOURCE_2 = `https://demos-europe-central.backblaze.faceit-cdn.net/cs2/${ROOM}-2-1.dem.zst`;
const SIGNED = `https://demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com/cs2/${ROOM}-1-1.dem.zst?X-Amz-Expires=299`;
const SIGNED_2 = SIGNED.replace(`${ROOM}-1-1`, `${ROOM}-2-1`);

describe("ExtensionService.assertSignedLinkFor", () => {
  it("accepts FACEIT's signed link to the demo FACEIT lists for the room", () => {
    expect(ExtensionService.assertSignedLinkFor(SIGNED, RESOURCE)).toBe(SIGNED);
  });

  it.each([
    [
      "a bucket someone registered to look like FACEIT's",
      SIGNED.replace(
        "demos-europe-central-faceit-cdn",
        "demos-evil-faceit-cdn",
      ),
    ],
    [
      "FACEIT's bucket for another region",
      SIGNED.replace(
        "demos-europe-central-faceit-cdn",
        "demos-us-east-faceit-cdn",
      ),
    ],
    ["plain http", SIGNED.replace("https:", "http:")],
    [
      "credentials in the url",
      SIGNED.replace("https://", "https://user:pass@"),
    ],
    [
      "a non-default port",
      SIGNED.replace("backblazeb2.com/", "backblazeb2.com:8443/"),
    ],
    [
      "a lookalike host",
      SIGNED.replace("backblazeb2.com", "backblazeb2.com.evil.example"),
    ],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data"],
    ["not a url", "demo.dem.zst"],
  ])("refuses %s", (_, url) => {
    expect(() => ExtensionService.assertSignedLinkFor(url, RESOURCE)).toThrow(
      BadRequestException,
    );
  });

  it("refuses a different file in FACEIT's bucket", () => {
    expect(() =>
      ExtensionService.assertSignedLinkFor(
        SIGNED.replace(`${ROOM}-1-1`, `${ROOM}-2-1`),
        RESOURCE,
      ),
    ).toThrow("demo url is for a different demo");
  });
});

describe("ExtensionService.externalIdFor", () => {
  it("keeps map 1 on the bare room id the FACEIT poller uses", () => {
    expect(ExtensionService.externalIdFor(ROOM, 1)).toBe(ROOM);
  });

  it("gives later maps of a series their own id", () => {
    expect(ExtensionService.externalIdFor(ROOM, 2)).toBe(`${ROOM}.2`);
  });
});

describe("ExtensionService imports", () => {
  type FakeJob = {
    state: string;
    failedReason?: string;
    data?: Record<string, unknown>;
    remove: jest.Mock;
  };

  function make({
    matches = [] as Array<{ id: string; external_id: string }>,
    fetchJobs = {} as Record<string, FakeJob>,
    parseJobs = {} as Record<string, FakeJob>,
    importsAllowed = true,
    lookupsAllowed = true,
  } = {}) {
    const query = jest.fn(async (_sql: string, [ids]: [unknown]) =>
      matches.filter((match) =>
        Array.isArray(ids)
          ? ids.includes(match.external_id)
          : ids === match.external_id,
      ),
    );
    const asJob = (job?: FakeJob) =>
      job && { data: {}, ...job, getState: async () => job.state };
    const fetchQueue = {
      getJob: jest.fn(async (id: string) => asJob(fetchJobs[id])),
      add: jest.fn(async (): Promise<void> => undefined),
    };
    const parseQueue = {
      getJob: jest.fn(async (id: string) => asJob(parseJobs[id])),
    };
    const stored = new Map<string, unknown>();
    const cache = {
      consume: jest.fn(async (key: string) =>
        key.startsWith("extension:imports:") ? importsAllowed : lookupsAllowed,
      ),
      get: jest.fn(async (key: string) => stored.get(key)),
      put: jest.fn(async (key: string, value: unknown) => {
        stored.set(key, value);
      }),
    };
    const faceit = {
      getMatchDemos: jest.fn(async () => ({
        demoUrls: [RESOURCE, RESOURCE_2],
        finishedAt: "2026-10-05T23:17:49.000Z",
        players: ["7656", "76561198000000002"],
      })),
    };
    const service = new ExtensionService(
      { query } as never,
      cache as never,
      {} as never,
      faceit as never,
      fetchQueue as never,
      parseQueue as never,
    );
    return { service, fetchQueue, cache, faceit };
  }

  const job = (
    state: string,
    extra: Partial<Omit<FakeJob, "state" | "remove">> = {},
  ): FakeJob => ({
    state,
    ...extra,
    remove: jest.fn(async (): Promise<void> => undefined),
  });

  const PLAYER = { steam_id: "7656", role: "user" as const };

  const demo = (map = 1) => ({
    matchId: ROOM,
    url: map === 1 ? SIGNED : SIGNED_2,
  });

  it("reports every map of a series that is already in 5Stack", async () => {
    const { service } = make({
      matches: [
        { id: "match-1", external_id: ROOM },
        { id: "match-2", external_id: `${ROOM}.2` },
      ],
    });

    await expect(
      service.lookupFaceit([{ id: ROOM, maps: 2 }]),
    ).resolves.toEqual({
      [ROOM]: { state: "imported", match_ids: ["match-1", "match-2"] },
    });
  });

  it("still offers a series with only some maps in 5Stack", async () => {
    const { service } = make({
      matches: [{ id: "match-1", external_id: ROOM }],
    });

    await expect(
      service.lookupFaceit([{ id: ROOM, maps: 2 }]),
    ).resolves.toEqual({ [ROOM]: { state: "none", match_ids: ["match-1"] } });
  });

  it("surfaces the failed map's reason even when another map imported", async () => {
    const { service } = make({
      matches: [{ id: "match-1", external_id: ROOM }],
      parseJobs: {
        [`ext.faceit.${ROOM}.2.parse`]: job("failed", {
          failedReason: "faceit wingman not supported",
        }),
      },
    });

    await expect(
      service.lookupFaceit([{ id: ROOM, maps: 2 }]),
    ).resolves.toEqual({
      [ROOM]: {
        state: "failed",
        match_ids: ["match-1"],
        reason: "faceit wingman not supported",
      },
    });
  });

  it("links a demo that matched a match already in 5Stack under another id", async () => {
    const { service } = make({
      parseJobs: {
        [`ext.faceit.${ROOM}.parse`]: job("completed", {
          data: { match_id: "match-from-upload" },
        }),
      },
    });

    await expect(service.lookupFaceit([{ id: ROOM }])).resolves.toEqual({
      [ROOM]: { state: "imported", match_ids: ["match-from-upload"] },
    });
  });

  it("says how far a demo's download has got", async () => {
    const { service } = make({
      fetchJobs: {
        [`ext.faceit.${ROOM}`]: job("active", { progress: 42 } as never),
      },
    });

    await expect(service.lookupFaceit([{ id: ROOM }])).resolves.toEqual({
      [ROOM]: {
        state: "importing",
        match_ids: [],
        stage: "downloading",
        progress: 42,
      },
    });
  });

  it("does not leave a finished download looking queued once its parse job is gone", async () => {
    const { service } = make({
      fetchJobs: { [`ext.faceit.${ROOM}`]: job("completed") },
    });

    await expect(service.lookupFaceit([{ id: ROOM }])).resolves.toEqual({
      [ROOM]: { state: "none", match_ids: [] },
    });
  });

  it("files a demo under the map FACEIT lists it as", async () => {
    const { service, fetchQueue } = make();

    await expect(service.queueFaceitDemo(PLAYER, demo(2))).resolves.toEqual({
      state: "queued",
    });
    expect(fetchQueue.add).toHaveBeenCalledWith(
      "FetchFaceitDemo",
      {
        url: SIGNED_2,
        external_id: `${ROOM}.2`,
        steam_id: "7656",
        match_start_time: "2026-10-05T23:17:49.000Z",
      },
      expect.objectContaining({ jobId: `ext.faceit.${ROOM}.2` }),
    );
  });

  it("asks FACEIT about a series once for all of its maps", async () => {
    const { service, faceit } = make();

    await service.queueFaceitDemo(PLAYER, demo(1));
    await service.queueFaceitDemo(PLAYER, demo(2));

    expect(faceit.getMatchDemos).toHaveBeenCalledTimes(1);
  });

  it("refuses a link to a demo FACEIT does not list for the match", async () => {
    const { service, fetchQueue } = make();

    await expect(
      service.queueFaceitDemo(PLAYER, {
        matchId: ROOM,
        url: SIGNED.replace(`${ROOM}-1-1`, `${ROOM}-3-1`),
      }),
    ).rejects.toThrow("not one of this match's FACEIT demos");
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });

  it("meters FACEIT lookups before spending the operator's quota", async () => {
    const { service, faceit } = make({ lookupsAllowed: false });

    const error = await service
      .queueFaceitDemo(PLAYER, demo())
      .catch((e: HttpException) => e);

    expect((error as HttpException).getStatus()).toBe(429);
    expect(faceit.getMatchDemos).not.toHaveBeenCalled();
  });

  it("re-queues an expired link under the same job id", async () => {
    const expired = job("failed", { failedReason: "link expired" });
    const { service, fetchQueue } = make({
      fetchJobs: { [`ext.faceit.${ROOM}`]: expired },
    });

    await service.queueFaceitDemo(PLAYER, demo());

    expect(expired.remove).toHaveBeenCalled();
    expect(fetchQueue.add).toHaveBeenCalled();
  });

  it("queues anyway when a stale job is locked by a worker", async () => {
    const locked = job("failed");
    locked.remove.mockRejectedValue(new Error("locked by another worker"));
    const { service, fetchQueue } = make({
      fetchJobs: { [`ext.faceit.${ROOM}`]: locked },
    });

    await service.queueFaceitDemo(PLAYER, demo());

    expect(fetchQueue.add).toHaveBeenCalled();
  });

  it("leaves a demo that is already importing alone", async () => {
    const { service, fetchQueue, cache } = make({
      fetchJobs: { [`ext.faceit.${ROOM}`]: job("active") },
    });

    await expect(service.queueFaceitDemo(PLAYER, demo())).resolves.toEqual({
      state: "importing",
      stage: "downloading",
      progress: 0,
    });
    expect(cache.consume).not.toHaveBeenCalledWith(
      "extension:imports:7656",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });

  it("does not fetch again a demo that already resolved to a match", async () => {
    const { service, fetchQueue, cache } = make({
      parseJobs: {
        [`ext.faceit.${ROOM}.parse`]: job("completed", {
          data: { match_id: "match-from-upload" },
        }),
      },
    });

    await expect(service.queueFaceitDemo(PLAYER, demo())).resolves.toEqual({
      state: "imported",
      match_id: "match-from-upload",
    });
    expect(cache.consume).not.toHaveBeenCalledWith(
      "extension:imports:7656",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });

  it("queues nothing when the old parse job cannot be cleared", async () => {
    const stuck = job("failed");
    stuck.remove.mockRejectedValue(new Error("redis unavailable"));
    const { service, fetchQueue } = make({
      parseJobs: { [`ext.faceit.${ROOM}.parse`]: stuck },
    });

    await expect(service.queueFaceitDemo(PLAYER, demo())).rejects.toThrow(
      "redis unavailable",
    );
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });

  it("says FACEIT did not answer rather than blaming the link", async () => {
    const { service, faceit } = make();
    faceit.getMatchDemos.mockResolvedValueOnce(null as never);

    const error = await service
      .queueFaceitDemo(PLAYER, demo())
      .catch((e: HttpException) => e);

    expect((error as HttpException).getStatus()).toBe(503);
  });

  it("refuses a match the player was not in", async () => {
    const { service, fetchQueue } = make();

    const error = await service
      .queueFaceitDemo({ steam_id: "76561198999999999", role: "user" }, demo())
      .catch((e: HttpException) => e);

    expect((error as HttpException).getStatus()).toBe(403);
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });

  it("lets a match organizer import a match they were not in", async () => {
    const { service, fetchQueue } = make();

    await service.queueFaceitDemo(
      { steam_id: "76561198999999999", role: "match_organizer" },
      demo(),
    );

    expect(fetchQueue.add).toHaveBeenCalled();
  });

  it("does not let a moderator import a match they were not in", async () => {
    const { service, fetchQueue } = make();

    const error = await service
      .queueFaceitDemo(
        { steam_id: "76561198999999999", role: "moderator" },
        demo(),
      )
      .catch((e: HttpException) => e);

    expect((error as HttpException).getStatus()).toBe(403);
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });

  it("refuses an import over the hourly limit", async () => {
    const { service, fetchQueue } = make({ importsAllowed: false });

    const error = await service
      .queueFaceitDemo(PLAYER, demo())
      .catch((e: HttpException) => e);

    expect((error as HttpException).getStatus()).toBe(429);
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });
});

describe("ExtensionService.imports", () => {
  function make({ allowed = true, apiKey = true, gc = true } = {}) {
    return new ExtensionService(
      {} as never,
      {} as never,
      {
        isImportingAllowed: async () => allowed,
        canImportShareCodes: async () => allowed && gc,
      } as never,
      { isEnabled: () => apiKey } as never,
      {} as never,
      {} as never,
    );
  }

  it("follows the match imports switch, not the FACEIT poller's", async () => {
    await expect(make().imports()).resolves.toEqual({
      faceit: true,
      valve: true,
    });
    await expect(make({ allowed: false }).imports()).resolves.toEqual({
      faceit: false,
      valve: false,
    });
  });

  it("needs the FACEIT Data API key that checks the links", async () => {
    await expect(make({ apiKey: false }).imports()).resolves.toMatchObject({
      faceit: false,
    });
  });
});
