import { randomUUID } from "crypto";
import { pipeline, Readable, Transform } from "stream";
import { Injectable, Logger } from "@nestjs/common";
import { Request, Response } from "express";
import { PoolClient } from "pg";
import { e_player_roles_enum } from "generated";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { PostgresService } from "../postgres/postgres.service";
import { S3Service } from "../s3/s3.service";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { ChatAttachment, ChatAttachmentKind } from "./types/ChatAttachment";

export interface ChatAttachmentUpload {
  name?: unknown;
  size?: unknown;
  mime_type?: unknown;
  width?: unknown;
  height?: unknown;
  duration_ms?: unknown;
}

export interface ChatAttachmentClaim {
  type: ChatLobbyType;
  roomId: string;
  steamId: string;
  messageId: string;
  expiresAt: Date | null;
}

export interface ChatAttachmentRow {
  id: string;
  uploader_steam_id: string | null;
  room_type: ChatLobbyType;
  room_id: string;
  storage_prefix: string;
  file_name: string;
  mime_type: string;
  size: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  poster_mime_type: string | null;
  upload_id: string | null;
  message_id: string | null;
  deleted_at: string | null;
}

export interface ChatAttachmentViewer {
  steam_id: string;
  role: e_player_roles_enum;
}

type Removable = Pick<ChatAttachmentRow, "id" | "storage_prefix" | "upload_id">;

@Injectable()
export class ChatAttachmentsService {
  public static readonly MAX_PER_MESSAGE = 4;

  // Each part is its own request through Cloudflare, which refuses a body over
  // 100 MB. S3 refuses a part under 5 MiB unless it is the last.
  public static readonly PART_SIZE = 8 * 1024 * 1024;

  public static readonly DEFAULT_MAX_MB = 100;

  private static readonly MAX_MB_CEILING = 1024;

  public static readonly PENDING_TTL_MS = 24 * 60 * 60 * 1000;

  // A file outlives its message by this much, so a message still on screen
  // when its room's TTL runs out never shows a broken image.
  public static readonly EXPIRY_GRACE_MS = 10 * 60 * 1000;

  public static readonly MAX_PENDING_PER_PLAYER = 20;

  public static readonly DEFAULT_DAILY_MB = 1024;

  private static readonly DAILY_MB_CEILING = 100 * 1024;

  // Per api pod: each part in flight holds a socket and a request to storage.
  public static readonly MAX_UPLOADS_PER_PLAYER = 2;

  public static readonly MAX_UPLOADS_PER_PROCESS = 16;

  public static readonly MAX_PIXELS = 40_000_000;

  private static readonly SNIFF_BYTES = 16;

  // A jpeg's size sits after its exif and colour profile, which can run long.
  private static readonly IMAGE_HEADER_BYTES = 1024 * 1024;

  public static readonly POSTER_MAX_BYTES = 2 * 1024 * 1024;

  private static readonly MAX_DIMENSION = 16384;

  private static readonly MAX_DURATION_MS = 24 * 60 * 60 * 1000;

  private static readonly MAX_NAME_LENGTH = 120;

  private static readonly SWEEP_BATCH = 500;

  public static readonly PREFIX = "chat-attachments";

  private static readonly SCOPES = ["rooms", "direct"] as const;

  public static readonly TYPES: Record<string, ChatAttachmentKind> = {
    "image/png": "image",
    "image/jpeg": "image",
    "image/webp": "image",
    "image/gif": "image",
    "video/mp4": "video",
    "video/webm": "video",
    "video/quicktime": "video",
  };

  private static readonly EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };

  private static readonly POSTER_TYPES = [
    "image/webp",
    "image/png",
    "image/jpeg",
  ];

  // Match and match_team lines are relayed into the game server, which can
  // only show text.
  private static readonly ROOMS = new Set<ChatLobbyType>([
    ChatLobbyType.MatchMaking,
    ChatLobbyType.Tournament,
    ChatLobbyType.Organizer,
    ChatLobbyType.Draft,
    ChatLobbyType.Direct,
  ]);

  private static readonly COLUMNS = `id::text AS id,
         uploader_steam_id::text AS uploader_steam_id, room_type, room_id,
         storage_prefix, file_name, mime_type, size::text AS size, width,
         height, duration_ms, poster_mime_type, upload_id,
         message_id::text AS message_id, deleted_at`;

  private readonly uploadsByPlayer = new Map<string, number>();
  private uploadsInFlight = 0;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly s3: S3Service,
  ) {}

  public static allowsAttachments(type: ChatLobbyType): boolean {
    return ChatAttachmentsService.ROOMS.has(type);
  }

  public static uploadRefusal(
    upload: ChatAttachmentUpload,
    maxBytes: number,
  ): ChatErrorCode | null {
    if (
      typeof upload.mime_type !== "string" ||
      !ChatAttachmentsService.TYPES[upload.mime_type]
    ) {
      return ChatErrorCode.UnsupportedType;
    }

    if (
      typeof upload.size !== "number" ||
      !Number.isSafeInteger(upload.size) ||
      upload.size <= 0
    ) {
      return ChatErrorCode.Invalid;
    }

    if (upload.size > maxBytes) {
      return ChatErrorCode.TooLarge;
    }

    return null;
  }

  public static maxFileBytesFrom(value: string | null | undefined): number {
    const megabytes = Number.parseInt(value ?? "", 10);

    if (!Number.isFinite(megabytes) || megabytes <= 0) {
      return ChatAttachmentsService.DEFAULT_MAX_MB * 1024 * 1024;
    }

    return (
      Math.min(megabytes, ChatAttachmentsService.MAX_MB_CEILING) * 1024 * 1024
    );
  }

  public static dailyQuotaBytesFrom(value: string | null | undefined): number {
    const megabytes = Number.parseInt(value ?? "", 10);

    if (!Number.isFinite(megabytes) || megabytes <= 0) {
      return ChatAttachmentsService.DEFAULT_DAILY_MB * 1024 * 1024;
    }

    return (
      Math.min(megabytes, ChatAttachmentsService.DAILY_MB_CEILING) * 1024 * 1024
    );
  }

  // Named for what the bytes are, so the extension a browser goes by can
  // never disagree with the type the file is served as.
  public static downloadName(name: string, mimeType: string): string {
    const extension = ChatAttachmentsService.EXTENSIONS[mimeType] ?? "bin";
    const dot = name.lastIndexOf(".");
    const base = (dot > 0 ? name.slice(0, dot) : name).trim() || "file";

    return `${base}.${extension}`;
  }

  public static imageSize(
    header: Buffer,
    mimeType: string,
  ): { width: number; height: number } | null {
    const size = ChatAttachmentsService.readImageSize(header, mimeType);

    if (!size || size.width <= 0 || size.height <= 0) {
      return null;
    }

    return size;
  }

  private static readImageSize(
    header: Buffer,
    mimeType: string,
  ): { width: number; height: number } | null {
    const ascii = (start: number, end: number) =>
      header.subarray(start, end).toString("latin1");

    switch (mimeType) {
      case "image/png":
        if (header.length < 24 || ascii(12, 16) !== "IHDR") {
          return null;
        }

        return {
          width: header.readUInt32BE(16),
          height: header.readUInt32BE(20),
        };
      case "image/gif":
        if (header.length < 10) {
          return null;
        }

        return {
          width: header.readUInt16LE(6),
          height: header.readUInt16LE(8),
        };
      case "image/webp":
        return ChatAttachmentsService.webpSize(header, ascii(12, 16));
      case "image/jpeg":
        return ChatAttachmentsService.jpegSize(header);
      default:
        return null;
    }
  }

  private static webpSize(
    header: Buffer,
    chunk: string,
  ): { width: number; height: number } | null {
    if (chunk === "VP8X" && header.length >= 30) {
      return {
        width: header.readUIntLE(24, 3) + 1,
        height: header.readUIntLE(27, 3) + 1,
      };
    }

    if (
      chunk === "VP8 " &&
      header.length >= 30 &&
      header[23] === 0x9d &&
      header[24] === 0x01 &&
      header[25] === 0x2a
    ) {
      return {
        width: header.readUInt16LE(26) & 0x3fff,
        height: header.readUInt16LE(28) & 0x3fff,
      };
    }

    if (chunk === "VP8L" && header.length >= 25 && header[20] === 0x2f) {
      const bits = header.readUInt32LE(21);

      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }

    return null;
  }

  // Each frame's image descriptor carries its own size, and a decoder sizes
  // its canvas from the first one whatever the screen size at the top of the
  // file says -- so a GIF whose first frame lies past `header` is refused.
  public static gifFrames(header: Buffer): {
    first: { width: number; height: number } | null;
    largest: number;
  } {
    let first: { width: number; height: number } | null = null;
    let largest = 0;

    if (header.length < 13) {
      return { first, largest };
    }

    let offset = 13;

    if (header[10] & 0x80) {
      offset += 3 * 2 ** ((header[10] & 0x07) + 1);
    }

    const skipSubBlocks = (from: number) => {
      let at = from;

      while (at < header.length && header[at] !== 0) {
        at += header[at] + 1;
      }

      return at + 1;
    };

    while (offset < header.length) {
      const block = header[offset];

      if (block === 0x3b) {
        break;
      }

      if (block === 0x21) {
        offset = skipSubBlocks(offset + 2);
        continue;
      }

      if (block !== 0x2c || offset + 10 > header.length) {
        break;
      }

      const width = header.readUInt16LE(offset + 5);
      const height = header.readUInt16LE(offset + 7);

      first ??= { width, height };
      largest = Math.max(largest, width * height);

      const packed = header[offset + 9];
      offset += 10;

      if (packed & 0x80) {
        offset += 3 * 2 ** ((packed & 0x07) + 1);
      }

      offset = skipSubBlocks(offset + 1);
    }

    return { first, largest };
  }

  // A strong, quoted ETag from what storage reports, which files-sdk hands
  // back unquoted.
  public static etag(raw: string | undefined): string | undefined {
    const bare = raw?.replace(/^W\//, "").replace(/"/g, "");

    return bare ? `"${bare}"` : undefined;
  }

  // If-None-Match compares weakly, so a W/ prefix still matches.
  public static notModified(
    header: string | undefined,
    etag: string | undefined,
  ): boolean {
    if (!header || !etag) {
      return false;
    }

    return header
      .split(",")
      .map((value) => value.trim())
      .some((value) => value === "*" || value.replace(/^W\//, "") === etag);
  }

  // Walks the segments to the first start-of-frame. DHT (C4), JPG (C8) and
  // DAC (CC) share the C0-CF range without being frames.
  private static jpegSize(
    header: Buffer,
  ): { width: number; height: number } | null {
    let offset = 2;

    while (offset + 4 <= header.length) {
      if (header[offset] !== 0xff) {
        return null;
      }

      const marker = header[offset + 1];

      if (marker === 0xff) {
        offset++;
        continue;
      }

      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset += 2;
        continue;
      }

      if (marker === 0xda || marker === 0xd9) {
        return null;
      }

      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      ) {
        if (offset + 9 > header.length) {
          return null;
        }

        return {
          width: header.readUInt16BE(offset + 7),
          height: header.readUInt16BE(offset + 5),
        };
      }

      offset += 2 + header.readUInt16BE(offset + 2);
    }

    return null;
  }

  public static fileName(raw: unknown): string {
    if (typeof raw !== "string") {
      return "file";
    }

    const base = raw
      .split(/[\\/]/)
      .pop()
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f"]/g, "")
      .trim();

    if (!base) {
      return "file";
    }

    const max = ChatAttachmentsService.MAX_NAME_LENGTH;

    if (base.length <= max) {
      return base;
    }

    const dot = base.lastIndexOf(".");
    const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";

    return `${base.slice(0, max - extension.length)}${extension}`;
  }

  public static sniff(header: Buffer): string | null {
    const ascii = (start: number, end: number) =>
      header.subarray(start, end).toString("latin1");

    if (
      header.length >= 8 &&
      header
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return "image/png";
    }

    if (
      header.length >= 3 &&
      header[0] === 0xff &&
      header[1] === 0xd8 &&
      header[2] === 0xff
    ) {
      return "image/jpeg";
    }

    if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
      return "image/gif";
    }

    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
      return "image/webp";
    }

    if (
      header.length >= 4 &&
      header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    ) {
      return "video/webm";
    }

    if (ascii(4, 8) === "ftyp") {
      return ascii(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
    }

    // QuickTime files older than the ftyp box open straight on another atom.
    if (["moov", "mdat", "wide", "free", "skip"].includes(ascii(4, 8))) {
      return "video/quicktime";
    }

    return null;
  }

  // A browser names a file's type from its extension, so a jpeg saved as .png
  // is still an image -- what is served is what the bytes are, as long as it is
  // the kind that was declared.
  public static contentType(declared: string, header: Buffer): string | null {
    const sniffed = ChatAttachmentsService.sniff(header);

    if (
      !sniffed ||
      ChatAttachmentsService.TYPES[sniffed] !==
        ChatAttachmentsService.TYPES[declared]
    ) {
      return null;
    }

    return sniffed;
  }

  public static posterType(header: Buffer): string | null {
    const sniffed = ChatAttachmentsService.sniff(header);

    return sniffed && ChatAttachmentsService.POSTER_TYPES.includes(sniffed)
      ? sniffed
      : null;
  }

  public static partCount(size: number): number {
    return Math.ceil(size / ChatAttachmentsService.PART_SIZE);
  }

  public static partLength(size: number, part: number): number | null {
    const parts = ChatAttachmentsService.partCount(size);

    if (!Number.isInteger(part) || part < 1 || part > parts) {
      return null;
    }

    if (part < parts) {
      return ChatAttachmentsService.PART_SIZE;
    }

    return size - (parts - 1) * ChatAttachmentsService.PART_SIZE;
  }

  public static pendingExpiry(now: Date): Date {
    return new Date(now.getTime() + ChatAttachmentsService.PENDING_TTL_MS);
  }

  public static expiresOnSend(
    type: ChatLobbyType,
    ttlSeconds: number,
    now: Date,
  ): Date | null {
    if (type === ChatLobbyType.Direct) {
      return null;
    }

    return new Date(
      now.getTime() +
        ttlSeconds * 1000 +
        ChatAttachmentsService.EXPIRY_GRACE_MS,
    );
  }

  // Filed by the day it was made, so the daily sweep can drop a whole day that
  // nothing points at in one call. Direct messages keep theirs for as long as
  // retention says, a room for a day or so -- apart, a lingering direct message
  // never holds a day of room files back.
  public static storagePrefix(
    type: ChatLobbyType,
    id: string,
    createdAt: Date,
  ): string {
    const scope = type === ChatLobbyType.Direct ? "direct" : "rooms";
    const day = createdAt.toISOString().slice(0, 10);

    return `${ChatAttachmentsService.PREFIX}/${scope}/${day}/${id}/`;
  }

  // A deleted message's files are evidence: gone from the room, its author
  // included, but kept for staff until they expire. The organizers' room's
  // evidence is closed to moderators, so its files are too.
  public static async canView(
    row: Pick<
      ChatAttachmentRow,
      "uploader_steam_id" | "message_id" | "room_type" | "deleted_at"
    >,
    viewer: ChatAttachmentViewer | undefined,
    roomAccess: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!viewer?.steam_id) {
      return false;
    }

    if (row.deleted_at) {
      return isRoleAbove(
        viewer.role,
        row.room_type === ChatLobbyType.Organizer
          ? "match_organizer"
          : "moderator",
      );
    }

    if (row.uploader_steam_id === String(viewer.steam_id)) {
      return true;
    }

    if (!row.message_id) {
      return false;
    }

    return await roomAccess();
  }

  public static parseRange(
    header: string,
    size: number,
  ): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

    if (!match || (match[1] === "" && match[2] === "")) {
      return null;
    }

    let start: number;
    let end: number;

    if (match[1] === "") {
      const suffix = Number.parseInt(match[2], 10);

      if (suffix <= 0) {
        return null;
      }

      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number.parseInt(match[1], 10);
      end = match[2] === "" ? size - 1 : Number.parseInt(match[2], 10);
    }

    if (start >= size || end < start) {
      return null;
    }

    return { start, end: Math.min(end, size - 1) };
  }

  private static dimension(raw: unknown, max: number): number | null {
    return typeof raw === "number" &&
      Number.isInteger(raw) &&
      raw > 0 &&
      raw <= max
      ? raw
      : null;
  }

  public static descriptor(row: ChatAttachmentRow): ChatAttachment {
    const kind = ChatAttachmentsService.TYPES[row.mime_type] ?? "image";

    return {
      id: row.id,
      kind,
      name: row.file_name,
      mime_type: row.mime_type,
      size: Number(row.size),
      ...(row.width ? { width: row.width } : {}),
      ...(row.height ? { height: row.height } : {}),
      ...(row.duration_ms ? { duration_ms: row.duration_ms } : {}),
      ...(row.poster_mime_type ? { poster: true } : {}),
    };
  }

  public async maxFileBytes(): Promise<number> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1`,
      [SystemSettingName.ChatAttachmentMaxMb],
    );

    return ChatAttachmentsService.maxFileBytesFrom(row?.value);
  }

  public async dailyQuotaBytes(): Promise<number> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1`,
      [SystemSettingName.ChatAttachmentDailyMb],
    );

    return ChatAttachmentsService.dailyQuotaBytesFrom(row?.value);
  }

  // The row goes in before anything reaches storage, so there is never a file
  // without something that will sweep it.
  public async create(
    steamId: string,
    type: ChatLobbyType,
    roomId: string,
    upload: ChatAttachmentUpload,
  ): Promise<
    { id: string; part_size: number; parts: number } | { code: ChatErrorCode }
  > {
    const refusal = ChatAttachmentsService.uploadRefusal(
      upload,
      await this.maxFileBytes(),
    );

    if (refusal) {
      return { code: refusal };
    }

    const size = upload.size as number;
    const mimeType = upload.mime_type as string;
    const id = randomUUID();
    const now = new Date();
    const prefix = ChatAttachmentsService.storagePrefix(type, id, now);
    const dailyBytes = await this.dailyQuotaBytes();

    // One player's uploads take turns here, so a burst of them cannot all
    // count the same allowance before any of them is written. The usage
    // ledger outlives the files, or uploading and removing the same file over
    // and over would cost nothing.
    const quotaRefusal = await this.postgres.transaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`chat_attachments:${steamId}`],
      );

      const {
        rows: [usage],
      } = await client.query<{ pending: number; bytes: string }>(
        `SELECT (SELECT count(*)::int
                   FROM public.chat_attachments
                  WHERE uploader_steam_id = $1::bigint
                    AND message_id IS NULL
                    AND expires_at > now()) AS pending,
                (SELECT COALESCE(sum(bytes), 0)::text
                   FROM public.chat_attachment_usage
                  WHERE steam_id = $1::bigint
                    AND created_at > now() - interval '1 day') AS bytes`,
        [steamId],
      );

      if (usage.pending >= ChatAttachmentsService.MAX_PENDING_PER_PLAYER) {
        return ChatErrorCode.TooManyPending;
      }

      if (Number(usage.bytes) + size > dailyBytes) {
        return ChatErrorCode.QuotaExceeded;
      }

      await client.query(
        `INSERT INTO public.chat_attachments
                (id, uploader_steam_id, room_type, room_id, storage_prefix,
                 file_name, mime_type, size, width, height, duration_ms,
                 expires_at, created_at)
         VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8::bigint,
                 $9::int, $10::int, $11::int, $12::timestamptz,
                 $13::timestamptz)`,
        [
          id,
          steamId,
          type,
          roomId,
          prefix,
          ChatAttachmentsService.fileName(upload.name),
          mimeType,
          size,
          ChatAttachmentsService.dimension(
            upload.width,
            ChatAttachmentsService.MAX_DIMENSION,
          ),
          ChatAttachmentsService.dimension(
            upload.height,
            ChatAttachmentsService.MAX_DIMENSION,
          ),
          ChatAttachmentsService.TYPES[mimeType] === "video"
            ? ChatAttachmentsService.dimension(
                upload.duration_ms,
                ChatAttachmentsService.MAX_DURATION_MS,
              )
            : null,
          ChatAttachmentsService.pendingExpiry(now).toISOString(),
          now.toISOString(),
        ],
      );

      await client.query(
        `INSERT INTO public.chat_attachment_usage (steam_id, bytes)
         VALUES ($1::bigint, $2::bigint)`,
        [steamId, size],
      );

      return null;
    });

    if (quotaRefusal) {
      return { code: quotaRefusal };
    }

    try {
      const uploadId = await this.s3.createMultipartUpload(`${prefix}file`);

      await this.postgres.query(
        `UPDATE public.chat_attachments SET upload_id = $2 WHERE id = $1::uuid`,
        [id, uploadId],
      );
    } catch (error) {
      await this.postgres.query(
        `DELETE FROM public.chat_attachments WHERE id = $1::uuid`,
        [id],
      );
      throw error;
    }

    return {
      id,
      part_size: ChatAttachmentsService.PART_SIZE,
      parts: ChatAttachmentsService.partCount(size),
    };
  }

  private async uploading(
    steamId: string,
    id: string,
  ): Promise<ChatAttachmentRow | undefined> {
    const [row] = await this.postgres.query<Array<ChatAttachmentRow>>(
      `SELECT ${ChatAttachmentsService.COLUMNS}
         FROM public.chat_attachments
        WHERE id = $1::uuid
          AND uploader_steam_id = $2::bigint
          AND upload_id IS NOT NULL
          AND message_id IS NULL
          AND expires_at > now()`,
      [id, steamId],
    );

    return row;
  }

  private acquireUploadSlot(steamId: string): (() => void) | null {
    const mine = this.uploadsByPlayer.get(steamId) ?? 0;

    if (
      mine >= ChatAttachmentsService.MAX_UPLOADS_PER_PLAYER ||
      this.uploadsInFlight >= ChatAttachmentsService.MAX_UPLOADS_PER_PROCESS
    ) {
      return null;
    }

    this.uploadsByPlayer.set(steamId, mine + 1);
    this.uploadsInFlight++;

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.uploadsInFlight--;

      const left = (this.uploadsByPlayer.get(steamId) ?? 1) - 1;

      if (left > 0) {
        this.uploadsByPlayer.set(steamId, left);
        return;
      }

      this.uploadsByPlayer.delete(steamId);
    };
  }

  private static async readHead(
    stream: Readable,
    bytes: number,
  ): Promise<{ head: Buffer; rest: Readable }> {
    const iterator = stream[Symbol.asyncIterator]();
    const chunks: Buffer[] = [];
    let length = 0;
    let ended = false;

    while (length < bytes) {
      const next = await iterator.next();

      if (next.done) {
        ended = true;
        break;
      }

      const chunk = Buffer.from(next.value);
      chunks.push(chunk);
      length += chunk.length;
    }

    async function* replay() {
      yield* chunks;

      if (ended) {
        return;
      }

      while (true) {
        const next = await iterator.next();

        if (next.done) {
          return;
        }

        yield next.value as Buffer;
      }
    }

    return {
      head: Buffer.concat(chunks).subarray(0, bytes),
      rest: Readable.from(replay(), { objectMode: false }),
    };
  }

  // Through pipeline, so an error on either side is handled here: the SDK
  // only pipes the body on, and a sender that drops mid-part would otherwise
  // re-emit an 'error' nothing listens for, which takes the process down. The
  // signal is what cancels the request to storage when that happens.
  private static exactly(
    source: Readable,
    length: number,
  ): { stream: Readable; failed: () => boolean; signal: AbortSignal } {
    let seen = 0;
    let failed = false;
    const controller = new AbortController();

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;

        if (seen > length) {
          callback(new Error("part is longer than it said"));
          return;
        }

        callback(null, chunk);
      },
      flush(callback) {
        if (seen !== length) {
          callback(new Error("part is shorter than it said"));
          return;
        }

        callback();
      },
    });

    pipeline(source, counter, (error) => {
      if (error) {
        failed = true;
        controller.abort(error);
      }
    });

    return {
      stream: counter,
      failed: () => failed,
      signal: controller.signal,
    };
  }

  // The first part is where the bytes say what the file really is, so that is
  // where anything else is turned away -- before any of it reaches storage.
  // The upload is authorized before a byte of the body is read, and the part
  // is streamed through rather than held.
  public async uploadPart(
    steamId: string,
    id: string,
    part: number,
    body: Readable | Buffer,
    declaredLength?: number,
  ): Promise<ChatErrorCode | null> {
    const stream = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    const length =
      declaredLength ?? (Buffer.isBuffer(body) ? body.length : Number.NaN);

    const release = this.acquireUploadSlot(steamId);

    if (!release) {
      return ChatErrorCode.RateLimited;
    }

    try {
      const row = await this.uploading(steamId, id);

      if (!row) {
        return ChatErrorCode.NotFound;
      }

      const expected = ChatAttachmentsService.partLength(
        Number(row.size),
        part,
      );

      if (expected === null || length !== expected) {
        return ChatErrorCode.Invalid;
      }

      let source = stream;

      if (part === 1) {
        let read: { head: Buffer; rest: Readable };

        try {
          read = await ChatAttachmentsService.readHead(
            stream,
            Math.min(
              expected,
              ChatAttachmentsService.TYPES[row.mime_type] === "image"
                ? ChatAttachmentsService.IMAGE_HEADER_BYTES
                : ChatAttachmentsService.SNIFF_BYTES,
            ),
          );
        } catch {
          return ChatErrorCode.Invalid;
        }

        const { head, rest } = read;

        const refusal = await this.checkFirstPart(row, head);

        if (refusal) {
          return refusal;
        }

        source = rest;
      }

      const checked = ChatAttachmentsService.exactly(source, expected);

      try {
        await this.s3.uploadPart(
          `${row.storage_prefix}file`,
          row.upload_id,
          part,
          checked.stream,
          expected,
          checked.signal,
        );
      } catch (error) {
        if (checked.failed()) {
          return ChatErrorCode.Invalid;
        }

        this.logger.warn(
          `unable to store part ${part} of chat attachment ${id}`,
          error,
        );
        return ChatErrorCode.Unavailable;
      }

      return null;
    } finally {
      release();
    }
  }

  // An image's real size comes from its own header: what the browser said is
  // only a guess, and a few kilobytes can claim to decode to gigapixels.
  private async checkFirstPart(
    row: ChatAttachmentRow,
    head: Buffer,
  ): Promise<ChatErrorCode | null> {
    const contentType = ChatAttachmentsService.contentType(
      row.mime_type,
      head.subarray(0, ChatAttachmentsService.SNIFF_BYTES),
    );

    if (!contentType) {
      await this.expire([row.id]);
      return ChatErrorCode.UnsupportedType;
    }

    let width = row.width;
    let height = row.height;

    if (ChatAttachmentsService.TYPES[contentType] === "image") {
      const size = ChatAttachmentsService.imageSize(head, contentType);

      if (
        !size ||
        (contentType === "image/gif" &&
          !ChatAttachmentsService.gifFrames(head).first)
      ) {
        await this.expire([row.id]);
        return ChatErrorCode.UnsupportedType;
      }

      if (
        size.width * size.height > ChatAttachmentsService.MAX_PIXELS ||
        (contentType === "image/gif" &&
          ChatAttachmentsService.gifFrames(head).largest >
            ChatAttachmentsService.MAX_PIXELS)
      ) {
        await this.expire([row.id]);
        return ChatErrorCode.TooLarge;
      }

      ({ width, height } = size);
    }

    await this.postgres.query(
      `UPDATE public.chat_attachments
          SET mime_type = $2, width = $3, height = $4
        WHERE id = $1::uuid`,
      [row.id, contentType, width, height],
    );

    return null;
  }

  public async complete(
    steamId: string,
    id: string,
  ): Promise<ChatAttachment | { code: ChatErrorCode }> {
    const row = await this.uploading(steamId, id);

    if (!row) {
      return { code: ChatErrorCode.NotFound };
    }

    const key = `${row.storage_prefix}file`;

    try {
      await this.s3.completeMultipartUpload(key, row.upload_id);
    } catch (error) {
      this.logger.warn(`unable to complete chat attachment ${id}`, error);
      return { code: ChatErrorCode.Invalid };
    }

    const stored = await this.s3.stat(key);

    if (stored.size !== Number(row.size)) {
      await this.postgres.query(
        `UPDATE public.chat_attachments
            SET upload_id = NULL, expires_at = now()
          WHERE id = $1::uuid`,
        [row.id],
      );
      await this.remove([{ ...row, upload_id: null }]);
      return { code: ChatErrorCode.Invalid };
    }

    const [completed] = await this.postgres.query<Array<ChatAttachmentRow>>(
      `UPDATE public.chat_attachments
          SET upload_id = NULL, uploaded_at = now()
        WHERE id = $1::uuid
    RETURNING ${ChatAttachmentsService.COLUMNS}`,
      [row.id],
    );

    return ChatAttachmentsService.descriptor(completed);
  }

  // Read whole only once the upload is known to be the player's, and only up
  // to the poster cap.
  public async setPoster(
    steamId: string,
    id: string,
    body: Readable | Buffer,
    declaredLength?: number,
  ): Promise<ChatErrorCode | null> {
    const length =
      declaredLength ?? (Buffer.isBuffer(body) ? body.length : Number.NaN);

    if (!(length > 0) || length > ChatAttachmentsService.POSTER_MAX_BYTES) {
      return ChatErrorCode.TooLarge;
    }

    const release = this.acquireUploadSlot(steamId);

    if (!release) {
      return ChatErrorCode.RateLimited;
    }

    try {
      const [row] = await this.postgres.query<Array<ChatAttachmentRow>>(
        `SELECT ${ChatAttachmentsService.COLUMNS}
           FROM public.chat_attachments
          WHERE id = $1::uuid
            AND uploader_steam_id = $2::bigint
            AND message_id IS NULL
            AND expires_at > now()`,
        [id, steamId],
      );

      if (!row) {
        return ChatErrorCode.NotFound;
      }

      if (ChatAttachmentsService.TYPES[row.mime_type] !== "video") {
        return ChatErrorCode.Invalid;
      }

      const checked = ChatAttachmentsService.exactly(
        Buffer.isBuffer(body) ? Readable.from([body]) : body,
        length,
      );
      const chunks: Buffer[] = [];

      try {
        for await (const chunk of checked.stream) {
          chunks.push(chunk as Buffer);
        }
      } catch {
        return ChatErrorCode.Invalid;
      }

      const poster = Buffer.concat(chunks);
      const posterType = ChatAttachmentsService.posterType(
        poster.subarray(0, ChatAttachmentsService.SNIFF_BYTES),
      );

      if (!posterType) {
        return ChatErrorCode.UnsupportedType;
      }

      await this.s3.put(`${row.storage_prefix}poster`, poster, posterType);

      await this.postgres.query(
        `UPDATE public.chat_attachments
            SET poster_mime_type = $2
          WHERE id = $1::uuid`,
        [row.id, posterType],
      );

      return null;
    } finally {
      release();
    }
  }

  // Taken out of the tray before it was ever sent.
  public async discard(steamId: string, id: string): Promise<boolean> {
    const rows = await this.postgres.query<Array<Removable>>(
      `UPDATE public.chat_attachments
          SET expires_at = now()
        WHERE id = $1::uuid
          AND uploader_steam_id = $2::bigint
          AND message_id IS NULL
    RETURNING id::text AS id, storage_prefix, upload_id`,
      [id, steamId],
    );

    if (rows.length === 0) {
      return false;
    }

    await this.remove(rows);

    return true;
  }

  // All of them or none: a message is never sent missing a file it was
  // composed with. FOR UPDATE makes a second send of the same file wait for
  // the first, then find it taken.
  public async claim(
    ids: string[],
    claim: ChatAttachmentClaim,
    client?: PoolClient,
  ): Promise<ChatAttachment[] | null> {
    if (ids.length === 0) {
      return [];
    }

    const sql = `WITH eligible AS (
         SELECT id AS eligible_id
           FROM public.chat_attachments
          WHERE id = ANY($1::uuid[])
            AND uploader_steam_id = $2::bigint
            AND room_type = $3
            AND room_id = $4
            AND message_id IS NULL
            AND deleted_at IS NULL
            AND uploaded_at IS NOT NULL
            AND expires_at > now()
            FOR UPDATE
       )
       UPDATE public.chat_attachments
          SET message_id = $5::uuid,
              sent_at = now(),
              expires_at = $6::timestamptz
         FROM eligible
        WHERE id = eligible.eligible_id
          AND (SELECT count(*) FROM eligible) = cardinality($1::uuid[])
    RETURNING ${ChatAttachmentsService.COLUMNS}`;

    const bindings = [
      ids,
      claim.steamId,
      claim.type,
      claim.roomId,
      claim.messageId,
      claim.expiresAt?.toISOString() ?? null,
    ];

    const rows: ChatAttachmentRow[] = client
      ? (await client.query(sql, bindings)).rows
      : await this.postgres.query<Array<ChatAttachmentRow>>(sql, bindings);

    if (rows.length !== ids.length) {
      return null;
    }

    return ids.map((id) =>
      ChatAttachmentsService.descriptor(rows.find((row) => row.id === id)),
    );
  }

  // Every one of the files already went out with a message from this sender,
  // in this room.
  public async sentBy(
    ids: string[],
    claim: Pick<ChatAttachmentClaim, "type" | "roomId" | "steamId">,
  ): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ sent: number }>>(
      `SELECT count(*)::int AS sent
         FROM public.chat_attachments
        WHERE id = ANY($1::uuid[])
          AND uploader_steam_id = $2::bigint
          AND room_type = $3
          AND room_id = $4
          AND message_id IS NOT NULL`,
      [ids, claim.steamId, claim.type, claim.roomId],
    );

    return (row?.sent ?? 0) === ids.length;
  }

  // A group room's deleted message keeps its files as evidence: hidden from
  // the room, kept for staff, and swept at the expiry they already had.
  public async markDeleted(
    type: ChatLobbyType,
    roomId: string,
    messageId: string,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.chat_attachments
          SET deleted_at = now()
        WHERE message_id = $1::uuid
          AND room_type = $2
          AND room_id = $3
          AND deleted_at IS NULL`,
      [messageId, type, roomId],
    );
  }

  // A direct message is not moderated, so deleting one takes its files with
  // it at once. A failed sweep is left to the next removeExpired.
  public async expireMessage(
    type: ChatLobbyType,
    roomId: string,
    messageId: string,
  ): Promise<void> {
    const rows = await this.postgres.query<Array<Removable>>(
      `UPDATE public.chat_attachments
          SET expires_at = now()
        WHERE message_id = $1::uuid
          AND room_type = $2
          AND room_id = $3
    RETURNING id::text AS id, storage_prefix, upload_id`,
      [messageId, type, roomId],
    );

    await this.remove(rows);
  }

  // A draft's chat carries on in its match room, where the moved messages take
  // that room's TTL from now. Their files follow, and are judged by who can
  // open the match.
  public async moveRoom(
    fromType: ChatLobbyType,
    fromId: string,
    toType: ChatLobbyType,
    toId: string,
    expiresAt: Date | null,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.chat_attachments
          SET room_type = $3,
              room_id = $4,
              expires_at = GREATEST(expires_at, $5::timestamptz)
        WHERE room_type = $1
          AND room_id = $2
          AND message_id IS NOT NULL
          AND deleted_at IS NULL
          AND expires_at > now()`,
      [fromType, fromId, toType, toId, expiresAt?.toISOString() ?? null],
    );
  }

  public async find(id: string): Promise<ChatAttachmentRow | undefined> {
    const [row] = await this.postgres.query<Array<ChatAttachmentRow>>(
      `SELECT ${ChatAttachmentsService.COLUMNS}
         FROM public.chat_attachments
        WHERE id = $1::uuid
          AND uploaded_at IS NOT NULL
          AND (expires_at IS NULL OR expires_at > now())`,
      [id],
    );

    return row;
  }

  public async removeExpired(): Promise<number> {
    await this.postgres.query(
      `DELETE FROM public.chat_attachment_usage
        WHERE created_at < now() - interval '1 day'`,
    );

    const rows = await this.postgres.query<Array<Removable>>(
      `SELECT id::text AS id, storage_prefix, upload_id
         FROM public.chat_attachments
        WHERE expires_at <= now()
        ORDER BY expires_at
        LIMIT ${ChatAttachmentsService.SWEEP_BATCH}`,
    );

    return await this.remove(rows);
  }

  private async expire(ids: string[]) {
    await this.postgres.query(
      `UPDATE public.chat_attachments
          SET expires_at = now()
        WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  }

  // Storage first, then the row: the row is the only thing that knows the file
  // is there, so a sweep that fails has to leave it for the next run.
  private async remove(rows: Removable[]): Promise<number> {
    let removed = 0;

    for (const row of rows) {
      if (row.upload_id) {
        try {
          await this.s3.abortMultipartUpload(
            `${row.storage_prefix}file`,
            row.upload_id,
          );
        } catch (error) {
          if (!ChatAttachmentsService.isNoSuchUpload(error)) {
            this.logger.warn(
              `unable to abort the upload of chat attachment ${row.id}, will retry`,
              error,
            );
            continue;
          }
        }

        await this.postgres.query(
          `UPDATE public.chat_attachments SET upload_id = NULL WHERE id = $1::uuid`,
          [row.id],
        );
      }

      try {
        await this.s3.removePrefixStrictly(row.storage_prefix);
      } catch (error) {
        this.logger.warn(
          `unable to remove chat attachment ${row.id}, will retry`,
          error,
        );
        continue;
      }

      await this.postgres.query(
        `DELETE FROM public.chat_attachments
          WHERE id = $1::uuid
            AND expires_at <= now()
            AND upload_id IS NULL`,
        [row.id],
      );

      removed++;
    }

    return removed;
  }

  private static isNoSuchUpload(error: unknown): boolean {
    const failure = error as {
      name?: string;
      Code?: string;
      $metadata?: { httpStatusCode?: number };
    };

    return (
      failure?.name === "NoSuchUpload" ||
      failure?.Code === "NoSuchUpload" ||
      failure?.$metadata?.httpStatusCode === 404
    );
  }

  // Anything left in storage that no row points at: a sweep whose row went
  // some other way, or a crash between the two. A day nothing points at goes in
  // one call. Today and yesterday are left alone while uploads may still land.
  public async sweepOrphans(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    let removed = 0;

    for (const scope of ChatAttachmentsService.SCOPES) {
      const root = `${ChatAttachmentsService.PREFIX}/${scope}/`;

      for (const day of await this.s3.listPrefixes(root)) {
        const date = day.slice(root.length, -1);

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= cutoff) {
          continue;
        }

        try {
          removed += await this.sweepDay(day);
        } catch (error) {
          this.logger.warn(
            `unable to sweep chat attachments under ${day}, will retry`,
            error,
          );
        }
      }
    }

    if (removed > 0) {
      this.logger.log(`swept ${removed} orphaned chat attachment object(s)`);
    }

    return removed;
  }

  private async sweepDay(day: string): Promise<number> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id
         FROM public.chat_attachments
        WHERE storage_prefix LIKE $1`,
      [`${day}%`],
    );

    if (rows.length === 0) {
      return await this.s3.removePrefixStrictly(day);
    }

    const known = new Set(rows.map(({ id }) => id));
    const strays = new Set<string>();

    for await (const object of this.s3.listStream(day)) {
      const id = object.name.slice(day.length).split("/")[0];

      if (id && !known.has(id)) {
        strays.add(id);
      }
    }

    let removed = 0;

    for (const id of strays) {
      removed += await this.s3.removePrefixStrictly(`${day}${id}/`);
    }

    return removed;
  }

  public async stream(
    key: string,
    contentType: string,
    fileName: string,
    request: Request,
    response: Response,
  ): Promise<void> {
    let size: number;
    let etag: string | undefined;

    try {
      const stored = await this.s3.stat(key);
      size = stored.size;
      etag = ChatAttachmentsService.etag(stored.etag);
    } catch (error) {
      const { code, name } = (error ?? {}) as { code?: string; name?: string };

      if (code === "NotFound" || name === "NotFound") {
        response.status(404).end();
        return;
      }

      throw error;
    }

    response.setHeader("Content-Type", contentType);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "sandbox");
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    // Revalidated on every view: who may open a room changes, and a deleted
    // message's files must stop showing at once, not when a cache lets go.
    response.setHeader("Cache-Control", "private, no-cache");

    if (etag) {
      response.setHeader("ETag", etag);

      if (
        ChatAttachmentsService.notModified(
          request.headers["if-none-match"],
          etag,
        )
      ) {
        response.status(304).end();
        return;
      }
    }

    const header = request.headers.range;
    const range = header
      ? ChatAttachmentsService.parseRange(header, size)
      : null;

    if (header && !range) {
      response.setHeader("Content-Range", `bytes */${size}`);
      response.status(416).end();
      return;
    }

    const stream = range
      ? await this.s3.getPartial(key, range.start, range.end - range.start + 1)
      : await this.s3.get(key);

    if (range) {
      response.status(206);
      response.setHeader(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${size}`,
      );
      response.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
      response.status(200);
      response.setHeader("Content-Length", String(size));
    }

    response.on("close", () => {
      stream.destroy();
    });

    stream.on("error", (error) => {
      this.logger.warn(`unable to stream ${key}`, error);
      response.destroy();
    });

    stream.pipe(response);
  }
}
