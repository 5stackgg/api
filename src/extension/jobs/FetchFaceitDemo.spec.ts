import { Readable } from "stream";
import { gzipSync, zstdCompressSync } from "zlib";
import { UnrecoverableError } from "bullmq";
import { FetchFaceitDemo } from "./FetchFaceitDemo";

const ROOM = "1-c0d53305-38d8-4d84-9f40-cd0a6032e5bd";
const DEMO = Buffer.concat([
  Buffer.from("PBDEMS2\0"),
  Buffer.alloc(64 * 1024, 7),
]);

function signedUrl(signedAt: Date, lifetimeSeconds = 299) {
  const stamp = signedAt.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  return `https://demos-europe-central-faceit-cdn.s3.eu-central-003.backblazeb2.com/cs2/${ROOM}-1-1.dem.zst?X-Amz-Date=${stamp}&X-Amz-Expires=${lifetimeSeconds}`;
}

describe("FetchFaceitDemo", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  function make() {
    const stored = new Map<string, Buffer>();
    const s3 = {
      put: jest.fn(async (key: string, stream: Readable) => {
        const chunks: Array<Buffer> = [];
        for await (const chunk of stream) {
          chunks.push(chunk as Buffer);
        }
        stored.set(key, Buffer.concat(chunks));
      }),
      remove: jest.fn(async () => true),
    };
    const processUploadQueue = {
      add: jest.fn(async (): Promise<void> => undefined),
    };
    const job = new FetchFaceitDemo(
      { log: jest.fn() } as never,
      s3 as never,
      processUploadQueue as never,
    );
    return { job, s3, stored, processUploadQueue };
  }

  function serve(body: Buffer, status = 200) {
    global.fetch = jest.fn(
      async () =>
        new Response(new Uint8Array(body), {
          status,
          headers: { "content-length": String(body.length) },
        }),
    ) as never;
  }

  const updateProgress = jest.fn(async (): Promise<void> => undefined);

  const run = (job: FetchFaceitDemo, url = signedUrl(new Date())) =>
    job.process({
      id: `ext.faceit.${ROOM}.2`,
      updateProgress,
      data: {
        url,
        external_id: `${ROOM}.2`,
        steam_id: "76561198000000001",
        match_start_time: "2026-10-05T23:17:49.000Z",
      },
    } as never);

  it("stores FACEIT's zstd demo as a plain .dem and hands it to the parser", async () => {
    const { job, stored, processUploadQueue } = make();
    serve(zstdCompressSync(DEMO));

    await run(job);

    const [[key, demo]] = [...stored];
    expect(key).toMatch(/^demo-uploads\/76561198000000001\/.+\.dem$/);
    expect(demo.equals(DEMO)).toBe(true);
    expect(processUploadQueue.add).toHaveBeenCalledWith(
      "ProcessUploadedDemo",
      {
        key,
        file_name: `${ROOM}.2.dem`,
        steam_id: "76561198000000001",
        external_id: `${ROOM}.2`,
        source: "faceit",
        match_start_time: "2026-10-05T23:17:49.000Z",
      },
      expect.objectContaining({ jobId: `ext.faceit.${ROOM}.2.parse` }),
    );
  });

  it("reports how much of FACEIT's file has arrived", async () => {
    const { job } = make();
    updateProgress.mockClear();
    const zstd = zstdCompressSync(DEMO);
    const chunks = Array.from({ length: 10 }, (_, i) =>
      zstd.subarray(
        Math.floor((zstd.length * i) / 10),
        Math.floor((zstd.length * (i + 1)) / 10),
      ),
    );
    global.fetch = jest.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              const next = chunks.shift();
              if (next) {
                controller.enqueue(new Uint8Array(next));
              } else {
                controller.close();
              }
            },
          }),
          { headers: { "content-length": String(zstd.length) } },
        ),
    ) as never;

    await run(job);

    const reported = updateProgress.mock.calls.map(
      (call) => (call as unknown as [number])[0],
    );
    expect(reported.length).toBeGreaterThan(3);
    expect(reported).toEqual([...reported].sort((a, b) => a - b));
    expect(Math.max(...reported)).toBeLessThan(100);
  });

  it("also takes the older gzip demos", async () => {
    const { job, stored } = make();
    serve(gzipSync(DEMO));

    await run(job);

    expect([...stored.values()][0].equals(DEMO)).toBe(true);
  });

  it("gives up on a link that has already expired without fetching it", async () => {
    const { job } = make();
    global.fetch = jest.fn() as never;

    await expect(
      run(job, signedUrl(new Date(Date.now() - 10 * 60 * 1000))),
    ).rejects.toThrow(new UnrecoverableError("link expired"));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reads FACEIT's 403 as an expired link", async () => {
    const { job } = make();
    serve(Buffer.from("AccessDenied"), 403);

    await expect(run(job)).rejects.toThrow("link expired");
  });

  it("reads the demo's magic across a first chunk shorter than it", async () => {
    const { job, stored } = make();
    const zstd = zstdCompressSync(DEMO);
    const chunks = [zstd.subarray(0, 3), zstd.subarray(3)];
    global.fetch = jest.fn(
      async () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              const next = chunks.shift();
              if (!next) {
                controller.close();
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
              controller.enqueue(new Uint8Array(next));
            },
          }),
        ),
    ) as never;

    await run(job);

    expect([...stored.values()][0].equals(DEMO)).toBe(true);
  });

  it("removes what it stored and queues nothing when storing fails", async () => {
    const { job, s3, processUploadQueue } = make();
    s3.put.mockRejectedValueOnce(new Error("bucket unavailable"));
    serve(zstdCompressSync(DEMO));

    await expect(run(job)).rejects.toThrow("bucket unavailable");
    expect(s3.remove).toHaveBeenCalledWith(
      expect.stringMatching(/^demo-uploads\/76561198000000001\//),
    );
    expect(processUploadQueue.add).not.toHaveBeenCalled();
  });

  it("removes what it stored when the parse cannot be queued", async () => {
    const { job, s3, stored, processUploadQueue } = make();
    processUploadQueue.add.mockRejectedValueOnce(
      new Error("redis unavailable"),
    );
    serve(zstdCompressSync(DEMO));

    await expect(run(job)).rejects.toThrow("redis unavailable");
    expect(s3.remove).toHaveBeenCalledWith([...stored.keys()][0]);
  });

  it("queues the parse behind admin uploads", async () => {
    const { job, processUploadQueue } = make();
    serve(zstdCompressSync(DEMO));

    await run(job);

    expect(processUploadQueue.add).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ priority: 10 }),
    );
  });

  it("refuses bytes that are not a demo", async () => {
    const { job, s3 } = make();
    serve(Buffer.from("<html>not a demo</html>"));

    await expect(run(job)).rejects.toThrow("not a CS2 demo");
    expect(s3.put).not.toHaveBeenCalled();
  });
});
