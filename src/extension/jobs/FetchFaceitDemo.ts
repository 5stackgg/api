import { randomUUID } from "crypto";
import { once } from "events";
import { pipeline, PassThrough, Readable } from "stream";
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

// FACEIT signs a demo link for five minutes, so nothing may sit in front of
// the download: parsing runs behind ProcessUploadedDemo's rate limit, and the
// link would expire waiting there.
@UseQueue("Extension", ExtensionQueues.FetchFaceitDemo, { concurrency: 4 })
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
    if (Number(response.headers.get("content-length")) > MAX_DEMO_SIZE) {
      throw new UnrecoverableError("demo exceeds 2GB limit");
    }

    const body = Readable.fromWeb(response.body as ReadableStream);
    const demo = FetchFaceitDemo.decompress(
      body,
      await FetchFaceitDemo.peek(body),
    );

    const key = `demo-uploads/${steam_id}/${randomUUID()}.dem`;
    try {
      await this.s3.put(key, demo);
    } catch (error) {
      await this.s3.remove(key);
      throw error;
    }

    this.logger.log(
      `fetch-faceit-demo stored external_id=${external_id} steam_id=${steam_id} key=${key}`,
    );

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
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );
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
    await once(stream, "readable");
    const head = (stream.read(CS2_DEMO_MAGIC.length) ??
      stream.read()) as Buffer | null;
    if (!head) {
      throw new UnrecoverableError("FACEIT sent an empty demo");
    }
    stream.unshift(head);
    return head;
  }

  private static decompress(stream: Readable, head: Buffer): Readable {
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
    return pipeline(stream, decoder, () => {});
  }
}
