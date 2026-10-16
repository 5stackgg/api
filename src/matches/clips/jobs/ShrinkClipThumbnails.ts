import { Job, Queue } from "bullmq";
import { InjectQueue, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import sharp from "sharp";
import { MatchQueues } from "../../enums/MatchQueues";
import { UseQueue } from "../../../utilities/QueueProcessors";
import { PostgresService } from "../../../postgres/postgres.service";
import { S3Service } from "../../../s3/s3.service";
import { ClipsService } from "../clips.service";

// Re-encodes the full-size thumbnails stored before uploads were shrunk.
//
// The shrunk copy goes to a NEW key rather than over the old one: the CDN
// caches a thumbnail as immutable for 30 days under a URL whose `v=` is the
// clip's created_at, so rewriting the object in place would go unseen for a
// month. A new key is a new signed URL.
//
// The clips queue runs one job at a time, so this does a page per job and
// queues the next page behind whatever else is waiting. Runs once, marked by a
// settings row that also prefixes every page's jobId: an earlier pass's
// completed pages share cursors with this one, and BullMQ silently drops an
// add whose jobId it still holds. A page left queued by an earlier pass is
// dropped -- the head walks the whole table anyway, and that page reaching the
// end first would set the marker before the head had looked at anything.
//
// A row already on its shrunk key still gets its original swept: an earlier
// pass removed it with a plain delete, which on a versioned bucket only hides
// it behind a delete marker and keeps it billed.
export const SHRINK_CLIP_THUMBNAILS_RUN = "clip_thumbnails_resized";
const SHRUNK_SUFFIX = `-${ClipsService.THUMBNAIL_WIDTH}.jpg`;
const PAGE_SIZE = 25;

@UseQueue("Clips", MatchQueues.Clips)
export class ShrinkClipThumbnails extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
    @InjectQueue(MatchQueues.Clips) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ after?: string; shrunk?: number }>) {
    if (
      job.id !== SHRINK_CLIP_THUMBNAILS_RUN &&
      !job.id?.startsWith(`${SHRINK_CLIP_THUMBNAILS_RUN}.`)
    ) {
      return;
    }

    if (!job.data.after) {
      const [done] = await this.postgres.query<Array<{ value: string }>>(
        `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
        [SHRINK_CLIP_THUMBNAILS_RUN],
      );

      if (done) {
        return;
      }
    }

    const rows = await this.postgres.query<
      Array<{ id: string; thumbnail_url: string }>
    >(
      `SELECT id, thumbnail_url FROM public.match_clips
        WHERE thumbnail_url IS NOT NULL
          AND ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id
        LIMIT $2`,
      [job.data.after ?? null, PAGE_SIZE],
    );

    let shrunk = job.data.shrunk ?? 0;
    for (const row of rows) {
      try {
        if (row.thumbnail_url.endsWith(SHRUNK_SUFFIX)) {
          await this.s3.removePrefixStrictly(
            `${row.thumbnail_url.slice(0, -SHRUNK_SUFFIX.length)}.jpg`,
          );
          continue;
        }

        if (await this.shrink(row.id, row.thumbnail_url)) {
          shrunk++;
        }
      } catch (error) {
        this.logger.warn(
          `[clip ${row.id}] thumbnail shrink failed: ${(error as Error)?.message}`,
        );
      }
    }

    if (rows.length < PAGE_SIZE) {
      await this.postgres.query(
        `INSERT INTO public.settings (name, value) VALUES ($1, 'true')
         ON CONFLICT (name) DO NOTHING`,
        [SHRINK_CLIP_THUMBNAILS_RUN],
      );
      this.logger.log(`shrank ${shrunk} clip thumbnail(s)`);
      return;
    }

    const after = rows[rows.length - 1].id;
    await this.queue.add(
      ShrinkClipThumbnails.name,
      { after, shrunk },
      { jobId: `${SHRINK_CLIP_THUMBNAILS_RUN}.${after}` },
    );
  }

  private async shrink(clipId: string, key: string): Promise<boolean> {
    if (!(await this.s3.has(key))) {
      return false;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of await this.s3.get(key)) {
      chunks.push(chunk as Buffer);
    }
    const original = Buffer.concat(chunks);

    const { width } = await sharp(original).metadata();
    if (!width || width <= ClipsService.THUMBNAIL_WIDTH) {
      return false;
    }

    const shrunk = await ClipsService.shrinkThumbnail(original);
    const shrunkKey = key.replace(/(\.[a-z]+)?$/i, SHRUNK_SUFFIX);
    await this.s3.put(shrunkKey, shrunk, "image/jpeg");

    const updated = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.match_clips
          SET thumbnail_url = $2,
              size = GREATEST(size - $3 + $4, 0)
        WHERE id = $1 AND thumbnail_url = $5
        RETURNING id`,
      [clipId, shrunkKey, original.length, shrunk.length, key],
    );

    if (updated.length === 0) {
      const [current] = await this.postgres.query<
        Array<{ thumbnail_url: string | null }>
      >(`SELECT thumbnail_url FROM public.match_clips WHERE id = $1`, [clipId]);
      if (current?.thumbnail_url !== shrunkKey) {
        await this.s3.removePrefixStrictly(shrunkKey);
      }
      return false;
    }

    await this.s3.removePrefixStrictly(key);
    return true;
  }
}
