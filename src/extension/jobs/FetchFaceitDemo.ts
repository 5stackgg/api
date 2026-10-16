import { randomUUID } from "crypto";
import { pipeline, PassThrough, Readable, Transform } from "stream";
import { ReadableStream } from "stream/web";
import { createGunzip, createZstdDecompress } from "zlib";
import { Job, Queue, UnrecoverableError } from "bullmq";
import { Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { WorkerHost } from "@nestjs/bullmq";
import { UseQueue } from "../../utilities/QueueProcessors";
import { S3Service } from "../../s3/s3.service";
import { SteamMatchHistoryQueues } from "../../steam-match-history/enums/SteamMatchHistoryQueues";
import {
  ProcessUploadedDemo,
  ProcessUploadedDemoPayload,
} from "../../steam-match-history/jobs/ProcessUploadedDemo";
import { ExtensionQueues } from "../enums/ExtensionQueues";

export type FetchFaceitDemoPayload = {
  url: string;
  external_id: string;
  steam_id: string;
  match_start_time: string | null;
};

const MAX_DEMO_SIZE = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const CS2_DEMO_MAGIC = Buffer.from("PBDEMS2\0");

// FACEIT signs a demo link for five minutes and the download has to start
// inside them, so fetching is its own wide queue: parsing runs behind
// ProcessUploadedDemo's rate limit, and the link would expire waiting there.
@UseQueue("Extension", ExtensionQueues.FetchFaceitDemo, { concurrency: 12 })
export class FetchFaceitDemo extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    @InjectQueue(SteamMatchHistoryQueues.ProcessUploadedDemo)
    private readonly processUploadQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<FetchFaceitDemoPayload>): Promise<void> {
    const { url, external_id, steam_id, match_start_time } = job.data;

    const expiresAt = FetchFaceitDemo.linkExpiresAt(url);
    if (expiresAt !== null && Date.now() >= expiresAt) {
      throw new UnrecoverableError("link expired");
    }

    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new UnrecoverableError(
        response.status === 403
          ? "link expired"
          : `FACEIT storage answered ${response.status}`,
      );
    }
    const size = Number(response.headers.get("content-length")) || 0;
    if (size > MAX_DEMO_SIZE) {
      await response.body.cancel();
      throw new UnrecoverableError("demo exceeds 2GB limit");
    }

    const body = Readable.fromWeb(response.body as ReadableStream);
    const demo = FetchFaceitDemo.decompress(
      body,
      await FetchFaceitDemo.peek(body),
      FetchFaceitDemo.progress(job, size),
    );

    const key = `demo-uploads/${steam_id}/${randomUUID()}.dem`;
    try {
      await this.s3.put(key, demo);

      this.logger.log(
        `fetch-faceit-demo stored external_id=${external_id} steam_id=${steam_id} key=${key}`,
      );

      // Behind admin uploads: a job with a priority waits for those without.
      await this.processUploadQueue.add(
        ProcessUploadedDemo.name,
        {
          key,
          file_name: `${external_id}.dem`,
          steam_id,
          external_id,
          source: "faceit",
          match_start_time,
        } satisfies ProcessUploadedDemoPayload,
        {
          jobId: `${job.id}.parse`,
          priority: 10,
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
        },
      );
    } catch (error) {
      demo.destroy();
      body.destroy();
      await this.s3.remove(key);
      throw error;
    }
  }

  public static linkExpiresAt(url: string): number | null {
    const params = new URL(url).searchParams;
    const signedAt = params
      .get("X-Amz-Date")
      ?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    const lifetime = Number(params.get("X-Amz-Expires"));
    if (!signedAt || !Number.isFinite(lifetime)) {
      return null;
    }
    const [, year, month, day, hour, minute, second] = signedAt.map(Number);
    return (
      Date.UTC(year, month - 1, day, hour, minute, second) + lifetime * 1000
    );
  }

  private static async peek(stream: Readable): Promise<Buffer> {
    const chunks: Array<Buffer> = [];
    let length = 0;
    while (length < CS2_DEMO_MAGIC.length && !stream.readableEnded) {
      const chunk = stream.read() as Buffer | null;
      if (chunk) {
        chunks.push(chunk);
        length += chunk.length;
        continue;
      }
      await FetchFaceitDemo.readableOrEnd(stream);
    }
    const head = Buffer.concat(chunks);
    if (head.length === 0) {
      throw new UnrecoverableError("FACEIT sent an empty demo");
    }
    stream.unshift(head);
    return head;
  }

  // A leftover 'readable' listener would stop the stream flowing into the
  // pipeline afterwards, so every listener added here is taken off again.
  private static readableOrEnd(stream: Readable): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        stream.off("readable", done);
        stream.off("end", done);
        stream.off("error", fail);
      };
      stream.on("readable", done);
      stream.on("end", done);
      stream.on("error", fail);
    });
  }

  // How much of FACEIT's file has arrived, for the extension's progress ring.
  // Reported in whole steps so the queue is not written on every chunk.
  private static progress(job: Job, size: number): Transform {
    let received = 0;
    let reported = 0;
    return new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        const percent = size
          ? Math.min(99, Math.floor((received / size) * 100))
          : 0;
        if (percent >= reported + 5) {
          reported = percent;
          void job.updateProgress(percent).catch((): undefined => undefined);
        }
        done(null, chunk);
      },
    });
  }

  private static decompress(
    stream: Readable,
    head: Buffer,
    counter: Transform,
  ): Readable {
    const decoder = head.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)
      ? createZstdDecompress()
      : head.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC)
        ? createGunzip()
        : head.subarray(0, CS2_DEMO_MAGIC.length).equals(CS2_DEMO_MAGIC)
          ? new PassThrough()
          : null;
    if (!decoder) {
      stream.destroy();
      throw new UnrecoverableError("not a CS2 demo");
    }
    return pipeline(stream, counter, decoder, () => {});
  }
}
