jest.mock("@kubernetes/client-node", () => ({
  BatchV1Api: class BatchV1Api {},
  CoreV1Api: class CoreV1Api {},
  KubeConfig: class KubeConfig {},
  Exec: class Exec {},
}));

import http from "http";
import { AddressInfo, connect } from "net";
import { Readable } from "stream";
import sharp from "sharp";
import { ClipsService } from "../clips.service";
import {
  SHRINK_CLIP_THUMBNAILS_RUN as HEAD,
  ShrinkClipThumbnails,
} from "./ShrinkClipThumbnails";

const jpeg = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 90, b: 160 },
    },
  })
    .jpeg()
    .toBuffer();

const clipId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function createJob(options: {
  done?: boolean;
  rows: Array<{ id: string; thumbnail_url: string }>;
  objects: Record<string, Buffer>;
  updatedRows?: number;
  currentUrl?: string;
}) {
  const objects = { ...options.objects };
  const postgres = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("SELECT value FROM public.settings")) {
        return options.done ? [{ value: "true" }] : [];
      }
      if (sql.includes("SELECT id, thumbnail_url")) {
        return options.rows;
      }
      if (sql.includes("SELECT thumbnail_url FROM public.match_clips")) {
        return [{ thumbnail_url: options.currentUrl ?? null }];
      }
      if (sql.includes("UPDATE public.match_clips")) {
        return Array.from({ length: options.updatedRows ?? 1 }, () => ({
          id: "x",
        }));
      }
      return [];
    }),
  };
  const s3 = {
    has: jest.fn(async (key: string) => key in objects),
    get: jest.fn(async (key: string) => Readable.from([objects[key]])),
    put: jest.fn(async (key: string, body: Buffer) => {
      objects[key] = body;
    }),
    removePrefixStrictly: jest.fn(async (prefix: string) => {
      for (const key of Object.keys(objects)) {
        if (key.startsWith(prefix)) {
          delete objects[key];
        }
      }
      return 1;
    }),
  };
  const queue = { add: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const job = new ShrinkClipThumbnails(
    logger as any,
    postgres as any,
    s3 as any,
    queue as any,
  );
  return { job, postgres, s3, queue, objects, logger };
}

const sqlCalls = (postgres: { query: jest.Mock }, fragment: string) =>
  postgres.query.mock.calls.filter(([sql]) => sql.includes(fragment));

describe("ClipsService.shrinkThumbnail", () => {
  it("brings a 1920x1080 capture down to 960x540 JPEG from an upload stream", async () => {
    const shrunk = await ClipsService.shrinkThumbnail(
      Readable.from([await jpeg(1920, 1080)]),
    );

    const meta = await sharp(shrunk).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(960);
    expect(meta.height).toBe(540);
  });

  it("rejects, rather than crashing the process, when the upload aborts mid-body", async () => {
    const uncaught = jest.fn();
    process.on("uncaughtException", uncaught);

    const settled = new Promise<string>((resolve) => {
      const server = http.createServer((request, response) => {
        ClipsService.shrinkThumbnail(request).then(
          () => resolve("resolved"),
          (error: Error) => resolve(`rejected: ${error.message}`),
        );
        response.on("close", () => server.close());
      });
      server.listen(0, () => {
        const socket = connect(
          (server.address() as AddressInfo).port,
          "127.0.0.1",
          () => {
            socket.write(
              "POST /thumbnail HTTP/1.1\r\nHost: x\r\nContent-Type: image/jpeg\r\nContent-Length: 100000\r\n\r\n",
            );
            socket.write(Buffer.alloc(1000, 1));
            setTimeout(() => socket.destroy(), 50);
          },
        );
      });
    });

    try {
      await expect(settled).resolves.toMatch(/^rejected: /);
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });

  it("does not enlarge a capture that is already small", async () => {
    const meta = await sharp(
      await ClipsService.shrinkThumbnail(await jpeg(640, 360)),
    ).metadata();
    expect(meta.width).toBe(640);
  });
});

describe("ShrinkClipThumbnails", () => {
  it("moves a full-size thumbnail to a new key, repoints the clip, and deletes the original", async () => {
    const original = await jpeg(1920, 1080);
    const { job, postgres, s3, queue, objects } = createJob({
      rows: [{ id: clipId(1), thumbnail_url: "clips/system/job-1.jpg" }],
      objects: { "clips/system/job-1.jpg": original },
    });

    await job.process({ id: HEAD, data: {} } as any);

    const shrunk = objects["clips/system/job-1-960.jpg"];
    expect((await sharp(shrunk).metadata()).width).toBe(960);
    expect(objects["clips/system/job-1.jpg"]).toBeUndefined();
    expect(s3.removePrefixStrictly).toHaveBeenCalledWith(
      "clips/system/job-1.jpg",
    );

    const [[, bindings]] = sqlCalls(postgres, "UPDATE public.match_clips");
    expect(bindings).toEqual([
      clipId(1),
      "clips/system/job-1-960.jpg",
      original.length,
      shrunk.length,
      "clips/system/job-1.jpg",
    ]);
    expect(s3.put).toHaveBeenCalledWith(
      "clips/system/job-1-960.jpg",
      shrunk,
      "image/jpeg",
    );

    expect(sqlCalls(postgres, "INSERT INTO public.settings")).toHaveLength(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("leaves a thumbnail that is already small where it is", async () => {
    const { job, postgres, s3 } = createJob({
      rows: [{ id: clipId(1), thumbnail_url: "clips/system/job-1.jpg" }],
      objects: { "clips/system/job-1.jpg": await jpeg(960, 540) },
    });

    await job.process({ id: HEAD, data: {} } as any);

    expect(s3.put).not.toHaveBeenCalled();
    expect(s3.removePrefixStrictly).not.toHaveBeenCalled();
    expect(sqlCalls(postgres, "UPDATE public.match_clips")).toHaveLength(0);
  });

  it("keeps the original when the clip changed underneath it", async () => {
    const { job, s3, objects } = createJob({
      rows: [{ id: clipId(1), thumbnail_url: "clips/system/job-1.jpg" }],
      objects: { "clips/system/job-1.jpg": await jpeg(1920, 1080) },
      updatedRows: 0,
      currentUrl: "clips/system/other.jpg",
    });

    await job.process({ id: HEAD, data: {} } as any);

    expect(objects["clips/system/job-1.jpg"]).toBeDefined();
    expect(objects["clips/system/job-1-960.jpg"]).toBeUndefined();
    expect(s3.removePrefixStrictly).toHaveBeenCalledWith(
      "clips/system/job-1-960.jpg",
    );
  });

  it("leaves the shrunk copy alone when another worker already moved the clip onto it", async () => {
    const { job, s3, objects } = createJob({
      rows: [{ id: clipId(1), thumbnail_url: "clips/system/job-1.jpg" }],
      objects: { "clips/system/job-1.jpg": await jpeg(1920, 1080) },
      updatedRows: 0,
      currentUrl: "clips/system/job-1-960.jpg",
    });

    await job.process({ id: HEAD, data: {} } as any);

    expect(objects["clips/system/job-1-960.jpg"]).toBeDefined();
    expect(s3.removePrefixStrictly).not.toHaveBeenCalled();
  });

  it("drops a page an earlier pass left queued", async () => {
    const { job, postgres, s3 } = createJob({
      rows: [{ id: clipId(1), thumbnail_url: "clips/system/job-1-960.jpg" }],
      objects: {},
    });

    await job.process({
      id: `ShrinkClipThumbnails.${clipId(0)}`,
      data: { after: clipId(0) },
    } as any);

    expect(postgres.query).not.toHaveBeenCalled();
    expect(s3.removePrefixStrictly).not.toHaveBeenCalled();
  });

  it("queues the next page after a full one instead of finishing", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: clipId(i + 1),
      thumbnail_url: `clips/system/gone-${i}.jpg`,
    }));
    const { job, postgres, queue } = createJob({ rows, objects: {} });

    await job.process({
      id: `${HEAD}.${clipId(0)}`,
      data: { after: clipId(0), shrunk: 3 },
    } as any);

    const [[, pageBindings]] = sqlCalls(postgres, "SELECT id, thumbnail_url");
    expect(pageBindings).toEqual([clipId(0), 25]);
    expect(queue.add).toHaveBeenCalledWith(
      "ShrinkClipThumbnails",
      { after: clipId(25), shrunk: 3 },
      { jobId: `clip_thumbnails_resized.${clipId(25)}` },
    );
    expect(sqlCalls(postgres, "INSERT INTO public.settings")).toHaveLength(0);
  });

  it("sweeps the original an earlier pass left behind for a thumbnail already moved", async () => {
    const { job, s3 } = createJob({
      rows: [{ id: clipId(1), thumbnail_url: "clips/system/job-1-960.jpg" }],
      objects: {},
    });

    await job.process({ id: HEAD, data: {} } as any);

    expect(s3.removePrefixStrictly).toHaveBeenCalledWith(
      "clips/system/job-1.jpg",
    );
    expect(s3.has).not.toHaveBeenCalled();
  });

  it("keeps paging after the marker is set, so a stray earlier page finishing first cannot stop it", async () => {
    const { job, s3 } = createJob({
      done: true,
      rows: [{ id: clipId(1), thumbnail_url: "clips/system/job-1-960.jpg" }],
      objects: {},
    });

    await job.process({
      id: `${HEAD}.${clipId(0)}`,
      data: { after: clipId(0) },
    } as any);

    expect(s3.removePrefixStrictly).toHaveBeenCalledWith(
      "clips/system/job-1.jpg",
    );
  });

  it("does nothing once it has finished", async () => {
    const { job, postgres, s3 } = createJob({
      done: true,
      rows: [{ id: clipId(1), thumbnail_url: "clips/system/job-1.jpg" }],
      objects: {},
    });

    await job.process({ id: HEAD, data: {} } as any);

    expect(postgres.query).toHaveBeenCalledTimes(1);
    expect(s3.has).not.toHaveBeenCalled();
  });
});
