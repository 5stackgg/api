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
    remove: jest.Mock;
  };

  function make({
    matches = [] as Array<{ id: string; external_id: string }>,
    fetchJobs = {} as Record<string, FakeJob>,
    parseJobs = {} as Record<string, FakeJob>,
    allowed = true,
  } = {}) {
    const query = jest.fn(async (_sql: string, [ids]: [unknown]) =>
      matches.filter((match) =>
        Array.isArray(ids)
          ? ids.includes(match.external_id)
          : ids === match.external_id,
      ),
    );
    const asJob = (job?: FakeJob) =>
      job && { ...job, getState: async () => job.state };
    const fetchQueue = {
      getJob: jest.fn(async (id: string) => asJob(fetchJobs[id])),
      add: jest.fn(async (): Promise<void> => undefined),
    };
    const parseQueue = {
      getJob: jest.fn(async (id: string) => asJob(parseJobs[id])),
    };
    const cache = { consume: jest.fn(async () => allowed) };
    const faceit = {
      getMatchDemos: jest.fn(async () => ({
        demoUrls: [RESOURCE, RESOURCE_2],
        finishedAt: "2026-10-05T23:17:49.000Z",
      })),
    };
    const service = new ExtensionService(
      { query } as never,
      cache as never,
      {} as never,
      faceit as never,
      {} as never,
      fetchQueue as never,
      parseQueue as never,
    );
    return { service, fetchQueue, cache, faceit };
  }

  const job = (state: string, failedReason?: string): FakeJob => ({
    state,
    failedReason,
    remove: jest.fn(async (): Promise<void> => undefined),
  });

  const demo = (map = 1) => ({
    matchId: ROOM,
    map,
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

  it("surfaces the failed map's reason even when another map imported", async () => {
    const { service } = make({
      matches: [{ id: "match-1", external_id: ROOM }],
      parseJobs: {
        [`ext.faceit.${ROOM}.2.parse`]: job(
          "failed",
          "faceit wingman not supported",
        ),
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

  it("queues a demo that is not in 5Stack yet", async () => {
    const { service, fetchQueue } = make();

    await expect(service.queueFaceitDemo("7656", demo(2))).resolves.toEqual({
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

  it("re-queues an expired link under the same job id", async () => {
    const expired = job("failed", "link expired");
    const { service, fetchQueue } = make({
      fetchJobs: { [`ext.faceit.${ROOM}`]: expired },
    });

    await service.queueFaceitDemo("7656", demo());

    expect(expired.remove).toHaveBeenCalled();
    expect(fetchQueue.add).toHaveBeenCalled();
  });

  it("leaves a demo that is already importing alone", async () => {
    const { service, fetchQueue, cache } = make({
      fetchJobs: { [`ext.faceit.${ROOM}`]: job("active") },
    });

    await expect(service.queueFaceitDemo("7656", demo())).resolves.toEqual({
      state: "importing",
    });
    expect(cache.consume).not.toHaveBeenCalled();
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });

  it("refuses a map FACEIT has no demo for", async () => {
    const { service, fetchQueue } = make();

    await expect(
      service.queueFaceitDemo("7656", { ...demo(), map: 3 }),
    ).rejects.toThrow("FACEIT has no demo for this map");
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });

  it("refuses an import over the hourly limit", async () => {
    const { service, fetchQueue } = make({ allowed: false });

    const error = await service
      .queueFaceitDemo("7656", demo())
      .catch((e: HttpException) => e);

    expect((error as HttpException).getStatus()).toBe(429);
    expect(fetchQueue.add).not.toHaveBeenCalled();
  });
});
