import { Injectable, Logger } from "@nestjs/common";
import { Readable } from "stream";
import * as crypto from "crypto";
import { PostgresService } from "src/postgres/postgres.service";
import { S3Service } from "src/s3/s3.service";
import { User } from "src/auth/types/User";

export type EventMediaRow = {
  id: string;
  event_id: string;
  uploader_steam_id: string;
  filename: string | null;
  mime_type: string | null;
  size: string;
  thumbnail_filename: string | null;
  external_url: string | null;
};

@Injectable()
export class EventsService {
  public static readonly MEDIA_PREFIX = "events";

  constructor(
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
    private readonly logger: Logger,
  ) {}

  public mediaKey(eventId: string, filename: string): string {
    return `${EventsService.MEDIA_PREFIX}/${eventId}/${filename}`;
  }

  /**
   * Access checks call the same Postgres functions the Hasura permissions
   * use (can_view_event / can_upload_event_media / is_event_organizer), so
   * REST media routes can never diverge from the GraphQL visibility rules.
   */
  public async canView(eventId: string, user?: User): Promise<boolean | null> {
    const [row] = await this.postgres.query<Array<{ can_view: boolean }>>(
      `SELECT public.can_view_event(e, $2::json) AS can_view
         FROM public.events e
        WHERE e.id = $1`,
      [eventId, this.sessionJson(user)],
    );
    return row ? row.can_view : null;
  }

  public async canUpload(eventId: string, user: User): Promise<boolean | null> {
    const [row] = await this.postgres.query<Array<{ can_upload: boolean }>>(
      `SELECT public.can_upload_event_media(e, $2::json) AS can_upload
         FROM public.events e
        WHERE e.id = $1`,
      [eventId, this.sessionJson(user)],
    );
    return row ? row.can_upload : null;
  }

  public async isOrganizer(eventId: string, user: User): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ is_organizer: boolean }>>(
      `SELECT public.is_event_organizer(e, $2::json) AS is_organizer
         FROM public.events e
        WHERE e.id = $1`,
      [eventId, this.sessionJson(user)],
    );
    return row?.is_organizer === true;
  }

  // Same setting the demo-upload flow uses: when a Cloudflare worker fronts
  // the B2 bucket, browser part PUTs must go through it — B2 has no CORS
  // rules, so direct presigned PUTs fail the preflight.
  public async getCloudflareWorkerUrl(): Promise<string | null> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = 'cloudflare_worker_url' LIMIT 1`,
    );
    const value = rows.at(0)?.value?.trim();
    return value ? value.replace(/\/+$/, "") : null;
  }

  public generateFilename(extension: string): string {
    return `${crypto.randomBytes(12).toString("hex")}.${extension}`;
  }

  public async saveMedia(media: {
    eventId: string;
    uploaderSteamId: string;
    filename: string;
    mimeType: string;
    size: number;
    title?: string | null;
  }): Promise<string> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.event_media
              (event_id, uploader_steam_id, filename, mime_type, size, title)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        media.eventId,
        media.uploaderSteamId,
        media.filename,
        media.mimeType,
        media.size,
        media.title ?? null,
      ],
    );
    this.logger.log(
      `event media saved event=${media.eventId} file=${media.filename} bytes=${media.size}`,
    );
    return row.id;
  }

  // External-link media (YouTube/Twitch/etc.) has no stored file: only the URL
  // and an optional title. The CHECK constraint enforces exactly one of
  // filename / external_url, so filename/mime_type stay null here.
  public async saveExternalMedia(media: {
    eventId: string;
    uploaderSteamId: string;
    externalUrl: string;
    title?: string | null;
  }): Promise<string> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.event_media
              (event_id, uploader_steam_id, external_url, title)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        media.eventId,
        media.uploaderSteamId,
        media.externalUrl,
        media.title ?? null,
      ],
    );
    this.logger.log(
      `event media link saved event=${media.eventId} url=${media.externalUrl}`,
    );
    return row.id;
  }

  // Matches either the media file itself or its poster frame, so both are
  // served (with the right mime) from the same GET route.
  public async getMedia(
    eventId: string,
    filename: string,
  ): Promise<(EventMediaRow & { is_thumbnail: boolean }) | undefined> {
    const [row] = await this.postgres.query<
      Array<EventMediaRow & { is_thumbnail: boolean }>
    >(
      `SELECT id, event_id, uploader_steam_id::text, filename, mime_type, size::text,
              thumbnail_filename, external_url, (thumbnail_filename = $2) AS is_thumbnail
         FROM public.event_media
        WHERE event_id = $1 AND (filename = $2 OR thumbnail_filename = $2)`,
      [eventId, filename],
    );
    return row;
  }

  public async getMediaById(
    eventId: string,
    mediaId: string,
  ): Promise<EventMediaRow | undefined> {
    const [row] = await this.postgres.query<Array<EventMediaRow>>(
      `SELECT id, event_id, uploader_steam_id::text, filename, mime_type, size::text,
              thumbnail_filename, external_url
         FROM public.event_media
        WHERE event_id = $1 AND id = $2`,
      [eventId, mediaId],
    );
    return row;
  }

  public async setMediaThumbnail(
    media: EventMediaRow,
    thumbnailFilename: string,
  ): Promise<void> {
    if (media.thumbnail_filename) {
      await this.s3.remove(
        this.mediaKey(media.event_id, media.thumbnail_filename),
      );
    }
    await this.postgres.query(
      `UPDATE public.event_media SET thumbnail_filename = $2 WHERE id = $1`,
      [media.id, thumbnailFilename],
    );
  }

  public async deleteMedia(media: EventMediaRow): Promise<void> {
    if (media.thumbnail_filename) {
      await this.s3.remove(
        this.mediaKey(media.event_id, media.thumbnail_filename),
      );
    }
    // External-link rows have no stored object to remove.
    if (media.filename) {
      await this.s3.remove(this.mediaKey(media.event_id, media.filename));
    }
    await this.postgres.query(`DELETE FROM public.event_media WHERE id = $1`, [
      media.id,
    ]);
    this.logger.log(
      `event media deleted event=${media.event_id} file=${media.filename}`,
    );
  }

  public async getMediaStream(
    eventId: string,
    filename: string,
  ): Promise<Readable> {
    return await this.s3.get(this.mediaKey(eventId, filename));
  }

  public async removeEventMedia(eventId: string): Promise<void> {
    const removed = await this.s3.removePrefix(
      `${EventsService.MEDIA_PREFIX}/${eventId}/`,
    );
    if (removed > 0) {
      this.logger.log(`removed ${removed} media objects for event ${eventId}`);
    }
  }

  // Default title: the uploaded file's name without its extension — far more
  // useful in the gallery than "Untitled".
  public titleFromFilename(name?: string | null): string | null {
    if (!name) {
      return null;
    }
    const stem = name.replace(/\.[^.]+$/, "").trim();
    return stem ? stem.slice(0, 120) : null;
  }

  private sessionJson(user?: User): string {
    // x-hasura-user-id is omitted (not empty) for guests: the SQL functions
    // cast it with ::bigint and an empty string would throw.
    return JSON.stringify({
      "x-hasura-role": user?.role ?? "guest",
      ...(user ? { "x-hasura-user-id": user.steam_id } : {}),
    });
  }
}
