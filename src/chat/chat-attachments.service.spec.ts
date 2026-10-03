import { PassThrough, Readable } from "stream";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

const MB = 1024 * 1024;

const header = (...parts: Array<string | number[]>) =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === "string"
        ? Buffer.from(part, "latin1")
        : Buffer.from(part),
    ),
  );

const PNG = header([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "IHDR");
const JPEG = header([0xff, 0xd8, 0xff, 0xe0], "JFIF");
const GIF = header("GIF89a", [0, 0, 0, 0]);
const WEBP = header("RIFF", [0, 0, 0, 0], "WEBPVP8 ");
const MP4 = header([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0]);
const MOV = header([0, 0, 0, 0x14], "ftypqt  ", [0, 0, 0, 0]);
const OLD_MOV = header([0, 0, 0, 0x08], "wide", [0, 0, 0, 0]);
const WEBM = header([0x1a, 0x45, 0xdf, 0xa3], [0x9f, 0x42, 0x86, 0x81]);
const HTML = header("<!doctype html><script>alert(1)</script>");
const SVG = header('<svg xmlns="http://www.w3.org/2000/svg">');

const u32be = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

const u16be = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
};

const u16le = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
};

const u24le = (value: number) =>
  Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);

const png = (width: number, height: number) =>
  Buffer.concat([
    PNG.subarray(0, 8),
    u32be(13),
    Buffer.from("IHDR"),
    u32be(width),
    u32be(height),
    Buffer.alloc(32),
  ]);

const jpeg = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    u16be(2 + 300),
    Buffer.alloc(300),
    Buffer.from([0xff, 0xc2]),
    u16be(11),
    Buffer.from([8]),
    u16be(height),
    u16be(width),
    Buffer.alloc(16),
  ]);

const gif = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from("GIF89a"),
    u16le(width),
    u16le(height),
    Buffer.alloc(16),
  ]);

const webpVp8x = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBPVP8X"),
    u32be(10),
    Buffer.alloc(4),
    u24le(width - 1),
    u24le(height - 1),
    Buffer.alloc(16),
  ]);

const webpVp8 = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBPVP8 "),
    Buffer.alloc(4),
    Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]),
    u16le(width),
    u16le(height),
    Buffer.alloc(16),
  ]);

const webpVp8l = (width: number, height: number) => {
  const bits = (width - 1) | ((height - 1) << 14);
  const packed = Buffer.alloc(4);
  packed.writeUInt32LE(bits >>> 0);
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBPVP8L"),
    Buffer.alloc(4),
    Buffer.from([0x2f]),
    packed,
    Buffer.alloc(16),
  ]);
};

describe("ChatAttachmentsService", () => {
  describe("which rooms take attachments", () => {
    it.each([
      ChatLobbyType.MatchMaking,
      ChatLobbyType.Tournament,
      ChatLobbyType.Organizer,
      ChatLobbyType.Draft,
      ChatLobbyType.Direct,
    ])("allows %s", (type) => {
      expect(ChatAttachmentsService.allowsAttachments(type)).toBe(true);
    });

    // Both are relayed into the CS2 server, which can only show text.
    it.each([ChatLobbyType.Match, ChatLobbyType.MatchTeam, ChatLobbyType.Team])(
      "keeps %s text-only",
      (type) => {
        expect(ChatAttachmentsService.allowsAttachments(type)).toBe(false);
      },
    );
  });

  describe("upload limits", () => {
    const upload = (overrides: Record<string, unknown> = {}) => ({
      name: "smoke.png",
      size: 1024,
      mime_type: "image/png",
      ...overrides,
    });

    it.each([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ])("accepts %s", (mimeType) => {
      expect(
        ChatAttachmentsService.uploadRefusal(
          upload({ mime_type: mimeType }),
          100 * MB,
        ),
      ).toBeNull();
    });

    it.each([
      "image/svg+xml",
      "text/html",
      "application/pdf",
      "audio/mpeg",
      "",
      undefined,
    ])("refuses %s", (mimeType) => {
      expect(
        ChatAttachmentsService.uploadRefusal(
          upload({ mime_type: mimeType }),
          100 * MB,
        ),
      ).toBe(ChatErrorCode.UnsupportedType);
    });

    it("holds every file to the operator's limit", () => {
      expect(
        ChatAttachmentsService.uploadRefusal(
          upload({ size: 100 * MB }),
          100 * MB,
        ),
      ).toBeNull();
      expect(
        ChatAttachmentsService.uploadRefusal(
          upload({ size: 100 * MB + 1 }),
          100 * MB,
        ),
      ).toBe(ChatErrorCode.TooLarge);
    });

    it.each([0, -1, 1.5, "10", null, Number.NaN])(
      "refuses a size of %p",
      (size) => {
        expect(
          ChatAttachmentsService.uploadRefusal(upload({ size }), 100 * MB),
        ).toBe(ChatErrorCode.Invalid);
      },
    );

    it("caps four attachments to a message", () => {
      expect(ChatAttachmentsService.MAX_PER_MESSAGE).toBe(4);
    });
  });

  describe("the operator's limit", () => {
    it.each([
      [null, 100 * MB],
      ["", 100 * MB],
      ["not a number", 100 * MB],
      ["0", 100 * MB],
      ["25", 25 * MB],
      ["100000", 1024 * MB],
    ])("reads %p as %p bytes", (value, bytes) => {
      expect(ChatAttachmentsService.maxFileBytesFrom(value)).toBe(bytes);
    });
  });

  describe("file names", () => {
    it.each([
      ["clutch.mp4", "clutch.mp4"],
      ["../../etc/passwd.png", "passwd.png"],
      ["C:\\Users\\me\\smoke b.png", "smoke b.png"],
      ["line\nbreak\u0000.png", "linebreak.png"],
      ["", "file"],
      [null, "file"],
      [42, "file"],
    ])("stores %p as %p", (raw, name) => {
      expect(ChatAttachmentsService.fileName(raw)).toBe(name);
    });

    it("keeps the extension of a name it has to shorten", () => {
      const name = ChatAttachmentsService.fileName(`${"a".repeat(400)}.webm`);

      expect(name.length).toBeLessThanOrEqual(120);
      expect(name.endsWith(".webm")).toBe(true);
    });
  });

  describe("content sniffing", () => {
    it.each([
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [GIF, "image/gif"],
      [WEBP, "image/webp"],
      [MP4, "video/mp4"],
      [MOV, "video/quicktime"],
      [OLD_MOV, "video/quicktime"],
      [WEBM, "video/webm"],
      [HTML, null],
      [SVG, null],
      [Buffer.alloc(0), null],
    ])("reads %#", (bytes, mimeType) => {
      expect(ChatAttachmentsService.sniff(bytes)).toBe(mimeType);
    });

    // A browser names the type from the extension, so a jpeg saved as .png is
    // still an image -- but nothing declared an image may turn out a video.
    it("serves what the bytes are, within the kind that was declared", () => {
      expect(ChatAttachmentsService.contentType("image/png", JPEG)).toBe(
        "image/jpeg",
      );
      expect(ChatAttachmentsService.contentType("video/quicktime", MP4)).toBe(
        "video/mp4",
      );
      expect(ChatAttachmentsService.contentType("image/png", MP4)).toBeNull();
      expect(ChatAttachmentsService.contentType("video/mp4", PNG)).toBeNull();
      expect(ChatAttachmentsService.contentType("image/png", HTML)).toBeNull();
    });

    it("only takes a still image as a video's poster", () => {
      expect(ChatAttachmentsService.posterType(WEBP)).toBe("image/webp");
      expect(ChatAttachmentsService.posterType(PNG)).toBe("image/png");
      expect(ChatAttachmentsService.posterType(JPEG)).toBe("image/jpeg");
      expect(ChatAttachmentsService.posterType(GIF)).toBeNull();
      expect(ChatAttachmentsService.posterType(HTML)).toBeNull();
    });
  });

  describe("image size", () => {
    it.each([
      ["a png", png(800, 600), "image/png"],
      ["a progressive jpeg past its exif", jpeg(800, 600), "image/jpeg"],
      ["a gif", gif(800, 600), "image/gif"],
      ["an extended webp", webpVp8x(800, 600), "image/webp"],
      ["a lossy webp", webpVp8(800, 600), "image/webp"],
      ["a lossless webp", webpVp8l(800, 600), "image/webp"],
    ])("reads %s from its header", (_, bytes, mimeType) => {
      expect(ChatAttachmentsService.imageSize(bytes, mimeType)).toEqual({
        width: 800,
        height: 600,
      });
    });

    it("gives up on a header it cannot read", () => {
      expect(ChatAttachmentsService.imageSize(JPEG, "image/jpeg")).toBeNull();
      expect(
        ChatAttachmentsService.imageSize(Buffer.alloc(4), "image/png"),
      ).toBeNull();
    });

    it("caps an image at 40 megapixels", () => {
      expect(ChatAttachmentsService.MAX_PIXELS).toBe(40_000_000);
    });
  });

  describe("download names", () => {
    it.each([
      ["smoke.png", "image/jpeg", "smoke.jpg"],
      ["clutch.MOV", "video/quicktime", "clutch.mov"],
      ["clip", "video/mp4", "clip.mp4"],
      ["evil.html", "image/png", "evil.png"],
      ["", "image/webp", "file.webp"],
    ])("serves %p as %p bytes under %p", (name, mimeType, served) => {
      expect(ChatAttachmentsService.downloadName(name, mimeType)).toBe(served);
    });
  });

  describe("the daily allowance", () => {
    it.each([
      [null, 1024 * MB],
      ["", 1024 * MB],
      ["0", 1024 * MB],
      ["500", 500 * MB],
    ])("reads %p as %p bytes", (value, bytes) => {
      expect(ChatAttachmentsService.dailyQuotaBytesFrom(value)).toBe(bytes);
    });
  });

  describe("uploading a part", () => {
    const ID = "0b7d6c1e-1111-4a2b-9c3d-000000000001";
    const PART = ChatAttachmentsService.PART_SIZE;

    let stored: Record<string, unknown> | null;
    let updates: Array<{ sql: string; bindings: any[] }>;
    let sent: Array<{ part: number; bytes: Buffer; length: number }>;
    let gate: Promise<void> | null;

    const upload = (overrides: Record<string, unknown> = {}) => ({
      id: ID,
      uploader_steam_id: "1",
      room_type: "matchmaking",
      room_id: "lobby-1",
      storage_prefix: `chat-attachments/rooms/2026-10-02/${ID}/`,
      file_name: "smoke.png",
      mime_type: "image/png",
      size: String(PART + 100),
      width: 10,
      height: 10,
      duration_ms: null,
      poster_mime_type: null,
      upload_id: "upload-1",
      message_id: null,
      deleted_at: null,
      ...overrides,
    });

    const postgres = {
      query: jest.fn(async (sql: string, bindings: any[] = []) => {
        if (sql.includes("upload_id IS NOT NULL")) {
          return stored ? [stored] : [];
        }

        updates.push({ sql, bindings });
        return [];
      }),
    };

    const s3 = {
      uploadPart: jest.fn(
        async (
          _key: string,
          _uploadId: string,
          part: number,
          body: Readable,
          length: number,
        ) => {
          const chunks: Buffer[] = [];
          for await (const chunk of body) {
            chunks.push(chunk as Buffer);
          }
          sent.push({ part, bytes: Buffer.concat(chunks), length });
          await gate;
        },
      ),
      abortMultipartUpload: jest.fn(),
      removePrefixStrictly: jest.fn(),
    };

    const service = () =>
      new ChatAttachmentsService(
        { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
        postgres as any,
        s3 as any,
      );

    // Hands the bytes over in small chunks, as a socket would, and counts how
    // many were ever asked for.
    const body = (bytes: Buffer) => {
      let offset = 0;
      const stream = new Readable({
        read() {
          stream.reads++;
          if (offset >= bytes.length) {
            this.push(null);
            return;
          }
          this.push(bytes.subarray(offset, offset + 64 * 1024));
          offset += 64 * 1024;
        },
      }) as Readable & { reads: number };
      stream.reads = 0;
      return stream;
    };

    const firstPart = (head: Buffer) =>
      Buffer.concat([head, Buffer.alloc(PART - head.length)]);

    beforeEach(() => {
      jest.clearAllMocks();
      stored = upload();
      updates = [];
      sent = [];
      gate = null;
    });

    it("checks the upload is the player's before reading a byte of it", async () => {
      stored = null;
      const part = body(firstPart(png(10, 10)));

      await expect(service().uploadPart("1", ID, 1, part, PART)).resolves.toBe(
        ChatErrorCode.NotFound,
      );

      expect(part.reads).toBe(0);
      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    it("refuses a part that says it is the wrong length, without reading it", async () => {
      const part = body(firstPart(png(10, 10)));

      await expect(
        service().uploadPart("1", ID, 1, part, PART - 1),
      ).resolves.toBe(ChatErrorCode.Invalid);

      expect(part.reads).toBe(0);
    });

    it("streams the part to storage with its length", async () => {
      const bytes = firstPart(png(10, 10));

      await expect(
        service().uploadPart("1", ID, 1, body(bytes), PART),
      ).resolves.toBeNull();

      expect(s3.uploadPart.mock.calls[0][3]).toBeInstanceOf(Readable);
      expect(sent).toEqual([{ part: 1, bytes, length: PART }]);
    });

    it("refuses a part that runs past the length it gave", async () => {
      stored = upload({ size: String(PART + 100) });

      await expect(
        service().uploadPart("1", ID, 2, body(Buffer.alloc(200)), 100),
      ).resolves.toBe(ChatErrorCode.Invalid);
    });

    it("refuses a part that stops short of the length it gave", async () => {
      await expect(
        service().uploadPart("1", ID, 2, body(Buffer.alloc(50)), 100),
      ).resolves.toBe(ChatErrorCode.Invalid);
    });

    it("checks the first part's bytes before sending any of it on", async () => {
      await expect(
        service().uploadPart("1", ID, 1, body(firstPart(HTML)), PART),
      ).resolves.toBe(ChatErrorCode.UnsupportedType);

      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    it("refuses an image over the pixel cap, whatever size it claimed", async () => {
      await expect(
        service().uploadPart(
          "1",
          ID,
          1,
          body(firstPart(png(10_000, 5_000))),
          PART,
        ),
      ).resolves.toBe(ChatErrorCode.TooLarge);

      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    // A GIF's frames carry their own size, and a decoder sizes its buffer
    // from them, whatever the screen size at the top says.
    // A decoder only grows its canvas for the first frame, so that frame has
    // to be seen; a long comment can push it past what is read ahead.
    it("refuses a GIF whose first frame is past what it reads ahead", async () => {
      stored = upload({ mime_type: "image/gif" });
      const comment = Buffer.alloc(1_100_000);
      const blocks: Buffer[] = [];
      for (let at = 0; at < comment.length; at += 255) {
        const block = comment.subarray(at, at + 255);
        blocks.push(Buffer.from([block.length]), block);
      }
      const gif = Buffer.concat([
        Buffer.from("GIF89a"),
        u16le(1),
        u16le(1),
        Buffer.from([0x00, 0x00, 0x00]),
        Buffer.from([0x21, 0xfe]),
        ...blocks,
        Buffer.from([0x00]),
        Buffer.from([0x2c]),
        u16le(0),
        u16le(0),
        u16le(65535),
        u16le(65535),
        Buffer.from([0x00]),
      ]);

      await expect(
        service().uploadPart("1", ID, 1, body(firstPart(gif)), PART),
      ).resolves.toBe(ChatErrorCode.UnsupportedType);
      expect(s3.uploadPart).not.toHaveBeenCalled();
    });

    it("refuses a GIF with a frame over the pixel cap, behind a small screen", async () => {
      stored = upload({ mime_type: "image/gif" });
      const frame = Buffer.concat([
        Buffer.from("GIF89a"),
        u16le(10),
        u16le(10),
        Buffer.from([0x00, 0x00, 0x00]),
        Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]),
        Buffer.from([0x2c]),
        u16le(0),
        u16le(0),
        u16le(10_000),
        u16le(5_000),
        Buffer.from([0x00]),
      ]);

      await expect(
        service().uploadPart("1", ID, 1, body(firstPart(frame)), PART),
      ).resolves.toBe(ChatErrorCode.TooLarge);
    });

    it("keeps the size the image really is, not the one it claimed", async () => {
      await service().uploadPart(
        "1",
        ID,
        1,
        body(firstPart(png(800, 600))),
        PART,
      );

      expect(
        updates.find(({ sql }) => sql.includes("SET mime_type"))?.bindings,
      ).toEqual([ID, "image/png", 800, 600]);
    });

    it("refuses an image whose size it cannot read", async () => {
      await expect(
        service().uploadPart("1", ID, 1, body(firstPart(PNG)), PART),
      ).resolves.toBe(ChatErrorCode.UnsupportedType);
    });

    it("lets one player send two parts at a time, and answers the third busy", async () => {
      stored = upload({ mime_type: "video/mp4", size: String(PART * 4) });
      let open = () => {};
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const attachments = service();
      const part = () => body(Buffer.alloc(PART));

      const first = attachments.uploadPart("1", ID, 2, part(), PART);
      const second = attachments.uploadPart("1", ID, 3, part(), PART);

      await expect(
        attachments.uploadPart("1", ID, 4, part(), PART),
      ).resolves.toBe(ChatErrorCode.RateLimited);

      const someoneElse = attachments.uploadPart("2", ID, 4, part(), PART);

      open();

      await expect(Promise.all([first, second, someoneElse])).resolves.toEqual([
        null,
        null,
        null,
      ]);

      await expect(
        attachments.uploadPart("1", ID, 4, part(), PART),
      ).resolves.toBeNull();
    });

    it("caps how many parts one process takes in at once", () => {
      expect(ChatAttachmentsService.MAX_UPLOADS_PER_PLAYER).toBe(2);
      expect(ChatAttachmentsService.MAX_UPLOADS_PER_PROCESS).toBe(16);
    });
  });

  describe("parts", () => {
    const PART = ChatAttachmentsService.PART_SIZE;

    // Cloudflare refuses a request body over 100 MB, so no single part can be.
    it("keeps every part well under Cloudflare's body cap", () => {
      expect(PART).toBeLessThanOrEqual(64 * MB);
      expect(PART).toBeGreaterThanOrEqual(5 * MB);
    });

    it.each([
      [1, 1],
      [PART, 1],
      [PART + 1, 2],
      [100 * MB, Math.ceil((100 * MB) / PART)],
    ])("splits %p bytes into %p part(s)", (size, parts) => {
      expect(ChatAttachmentsService.partCount(size)).toBe(parts);
    });

    it("expects full parts and a short last one", () => {
      const size = PART * 2 + 10;

      expect(ChatAttachmentsService.partLength(size, 1)).toBe(PART);
      expect(ChatAttachmentsService.partLength(size, 2)).toBe(PART);
      expect(ChatAttachmentsService.partLength(size, 3)).toBe(10);
    });

    it.each([0, 4, -1, 1.5, Number.NaN])(
      "has no part %p of a three part file",
      (part) => {
        expect(
          ChatAttachmentsService.partLength(PART * 2 + 10, part),
        ).toBeNull();
      },
    );
  });

  describe("expiry", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");

    it("gives an upload that is never sent a day", () => {
      expect(ChatAttachmentsService.pendingExpiry(now).toISOString()).toBe(
        "2026-10-03T12:00:00.000Z",
      );
    });

    it("lets a room's file live as long as the room keeps its messages", () => {
      const expiresAt = ChatAttachmentsService.expiresOnSend(
        ChatLobbyType.Tournament,
        7 * 24 * 60 * 60,
        now,
      );

      expect(expiresAt.getTime()).toBe(
        now.getTime() +
          7 * 24 * 60 * 60 * 1000 +
          ChatAttachmentsService.EXPIRY_GRACE_MS,
      );
    });

    it("never times out a direct message's file: it goes with the message", () => {
      expect(
        ChatAttachmentsService.expiresOnSend(ChatLobbyType.Direct, 3600, now),
      ).toBeNull();
    });
  });

  describe("storage layout", () => {
    const id = "6f1c0e2a-6a4b-4d2f-9a51-0d7f3b1c2e3d";

    it("files a room's upload under the day it was made", () => {
      expect(
        ChatAttachmentsService.storagePrefix(
          ChatLobbyType.MatchMaking,
          id,
          new Date("2026-10-02T23:59:59.000Z"),
        ),
      ).toBe(`chat-attachments/rooms/2026-10-02/${id}/`);
    });

    it("keeps direct messages' uploads apart, they outlive any room", () => {
      expect(
        ChatAttachmentsService.storagePrefix(
          ChatLobbyType.Direct,
          id,
          new Date("2026-10-02T00:00:00.000Z"),
        ),
      ).toBe(`chat-attachments/direct/2026-10-02/${id}/`);
    });
  });

  describe("who may see a file", () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      uploader_steam_id: "1",
      message_id: "m-1",
      room_type: "matchmaking",
      deleted_at: null,
      ...overrides,
    });

    const viewer = (steam_id: string, role = "user") =>
      ({ steam_id, role }) as any;

    it("always shows the uploader their own file", async () => {
      const roomAccess = jest.fn().mockResolvedValue(false);

      await expect(
        ChatAttachmentsService.canView(
          row({ message_id: null }) as any,
          viewer("1"),
          roomAccess,
        ),
      ).resolves.toBe(true);
      expect(roomAccess).not.toHaveBeenCalled();
    });

    it("shows nobody else a file that was never sent", async () => {
      const roomAccess = jest.fn().mockResolvedValue(true);

      await expect(
        ChatAttachmentsService.canView(
          row({ message_id: null }) as any,
          viewer("2"),
          roomAccess,
        ),
      ).resolves.toBe(false);
    });

    it("shows a sent file to whoever can open its room", async () => {
      await expect(
        ChatAttachmentsService.canView(
          row() as any,
          viewer("2"),
          async () => true,
        ),
      ).resolves.toBe(true);
      await expect(
        ChatAttachmentsService.canView(
          row() as any,
          viewer("2"),
          async () => false,
        ),
      ).resolves.toBe(false);
    });

    // Evidence: a deleted message's files stay for staff until they expire,
    // and go dark for everyone in the room, its author included.
    it("hides a deleted message's files from the room, its author too", async () => {
      const deleted = row({ deleted_at: "2026-10-02T12:00:00.000Z" }) as any;

      await expect(
        ChatAttachmentsService.canView(deleted, viewer("1"), async () => true),
      ).resolves.toBe(false);
      await expect(
        ChatAttachmentsService.canView(deleted, viewer("2"), async () => true),
      ).resolves.toBe(false);
    });

    it("still shows a deleted message's files to a moderator", async () => {
      const roomAccess = jest.fn().mockResolvedValue(false);

      await expect(
        ChatAttachmentsService.canView(
          row({ deleted_at: "2026-10-02T12:00:00.000Z" }) as any,
          viewer("9", "moderator"),
          roomAccess,
        ),
      ).resolves.toBe(true);
      expect(roomAccess).not.toHaveBeenCalled();
    });

    it("keeps the organizers' deleted files from moderators, like its evidence", async () => {
      const deleted = row({
        room_type: "organizers",
        deleted_at: "2026-10-02T12:00:00.000Z",
      }) as any;

      await expect(
        ChatAttachmentsService.canView(
          deleted,
          viewer("9", "moderator"),
          async () => false,
        ),
      ).resolves.toBe(false);
      await expect(
        ChatAttachmentsService.canView(
          deleted,
          viewer("9", "match_organizer"),
          async () => false,
        ),
      ).resolves.toBe(true);
    });

    it("shows nothing to a request without a player", async () => {
      await expect(
        ChatAttachmentsService.canView(
          row() as any,
          undefined,
          async () => true,
        ),
      ).resolves.toBe(false);
    });
  });

  describe("serving", () => {
    const s3 = {
      stat: jest.fn(async () => ({ size: 100, etag: "abc", metaData: {} })),
      get: jest.fn(async () => Readable.from([Buffer.alloc(100)])),
      getPartial: jest.fn(async () => Readable.from([Buffer.alloc(10)])),
    };

    const response = () => {
      const headers: Record<string, string> = {};
      const res = new PassThrough() as any;
      res.statusCode = 200;
      res.setHeader = (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      };
      res.status = (code: number) => {
        res.statusCode = code;
        return res;
      };
      res.headers = headers;
      res.resume();
      return res;
    };

    const service = () =>
      new ChatAttachmentsService(
        { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
        {} as any,
        s3 as any,
      );

    beforeEach(() => {
      jest.clearAllMocks();
    });

    // A deleted message's file must stop showing the moment it is deleted,
    // not an hour later from the browser's cache.
    it("makes every view ask again, with an ETag to keep that cheap", async () => {
      const res = response();

      await service().stream(
        "key",
        "image/png",
        "smoke.png",
        { headers: {} } as any,
        res,
      );

      expect(res.headers["cache-control"]).toBe("private, no-cache");
      expect(res.headers["etag"]).toBe('"abc"');
      expect(res.headers["etag"]).not.toMatch(/^W\//);
      expect(res.statusCode).toBe(200);
    });

    it.each([['"abc"'], ['W/"abc"'], ['"old", "abc"'], ["*"]])(
      "answers 304 to If-None-Match %s",
      async (header) => {
        const res = response();

        await service().stream(
          "key",
          "image/png",
          "smoke.png",
          { headers: { "if-none-match": header } } as any,
          res,
        );

        expect(res.statusCode).toBe(304);
        expect(s3.get).not.toHaveBeenCalled();
        expect(s3.getPartial).not.toHaveBeenCalled();
      },
    );

    it.each([['"old"'], ["abc"], [""]])(
      "sends the file to If-None-Match %p",
      async (header) => {
        const res = response();

        await service().stream(
          "key",
          "image/png",
          "smoke.png",
          { headers: { "if-none-match": header } } as any,
          res,
        );

        expect(res.statusCode).toBe(200);
      },
    );
  });

  describe("ranges", () => {
    it.each([
      ["bytes=0-99", 1000, { start: 0, end: 99 }],
      ["bytes=900-", 1000, { start: 900, end: 999 }],
      ["bytes=-100", 1000, { start: 900, end: 999 }],
      ["bytes=0-5000", 1000, { start: 0, end: 999 }],
      ["bytes=1000-", 1000, null],
      ["bytes=5-1", 1000, null],
      ["bytes=0-1,5-9", 1000, null],
      ["items=0-1", 1000, null],
    ])("reads %p of %p bytes", (value, size, range) => {
      expect(ChatAttachmentsService.parseRange(value, size)).toEqual(range);
    });
  });

  describe("cleanup", () => {
    const s3 = {
      removePrefixStrictly: jest.fn(),
      abortMultipartUpload: jest.fn(),
      listPrefixes: jest.fn(),
      listStream: jest.fn(),
    };

    let rows: Array<{
      id: string;
      storage_prefix: string;
      upload_id: string | null;
      expired: boolean;
    }>;
    let order: string[];

    const postgres = {
      query: jest.fn(async (sql: string, bindings: any[] = []) => {
        if (sql.includes("expires_at <= now()") && sql.includes("SELECT")) {
          return rows.filter((row) => row.expired);
        }

        if (sql.includes("DELETE FROM public.chat_attachments")) {
          order.push(`delete:${bindings[0]}`);
          rows = rows.filter((row) => row.id !== bindings[0]);
          return [];
        }

        if (sql.includes("SET upload_id = NULL")) {
          order.push(`aborted:${bindings[0]}`);
          rows = rows.map((row) =>
            row.id === bindings[0] ? { ...row, upload_id: null } : row,
          );
          return [];
        }

        if (sql.includes("LIKE")) {
          return rows
            .filter((row) =>
              row.storage_prefix.startsWith(
                String(bindings[0]).replace(/%$/, ""),
              ),
            )
            .map(({ id }) => ({ id }));
        }

        return [];
      }),
    };

    const service = () =>
      new ChatAttachmentsService(
        { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
        postgres as any,
        s3 as any,
      );

    const prefix = (day: string, id: string, scope = "rooms") =>
      `chat-attachments/${scope}/${day}/${id}/`;

    beforeEach(() => {
      jest.clearAllMocks();
      order = [];
      rows = [];
      s3.removePrefixStrictly.mockImplementation(async (value: string) => {
        order.push(`sweep:${value}`);
        return 1;
      });
      s3.abortMultipartUpload.mockImplementation(async (key: string) => {
        order.push(`abort:${key}`);
      });
      s3.listPrefixes.mockResolvedValue([]);
      s3.listStream.mockImplementation(async function* () {});
    });

    describe("expired files", () => {
      it("sweeps every version of a file before forgetting it", async () => {
        rows = [
          {
            id: "a-1",
            storage_prefix: prefix("2026-10-01", "a-1"),
            upload_id: null,
            expired: true,
          },
          {
            id: "a-2",
            storage_prefix: prefix("2026-10-01", "a-2"),
            upload_id: null,
            expired: false,
          },
        ];

        await expect(service().removeExpired()).resolves.toBe(1);

        expect(order).toEqual([
          `sweep:${prefix("2026-10-01", "a-1")}`,
          "delete:a-1",
        ]);
        expect(rows.map(({ id }) => id)).toEqual(["a-2"]);
      });

      it("aborts an upload that never finished, or its parts stay billed", async () => {
        rows = [
          {
            id: "a-1",
            storage_prefix: prefix("2026-10-01", "a-1"),
            upload_id: "upload-1",
            expired: true,
          },
        ];

        await service().removeExpired();

        expect(s3.abortMultipartUpload).toHaveBeenCalledWith(
          `${prefix("2026-10-01", "a-1")}file`,
          "upload-1",
        );
        expect(order).toEqual([
          `abort:${prefix("2026-10-01", "a-1")}file`,
          "aborted:a-1",
          `sweep:${prefix("2026-10-01", "a-1")}`,
          "delete:a-1",
        ]);
      });

      it("keeps the row when the sweep fails, so the next run tries again", async () => {
        rows = [
          {
            id: "a-1",
            storage_prefix: prefix("2026-10-01", "a-1"),
            upload_id: null,
            expired: true,
          },
        ];
        s3.removePrefixStrictly.mockRejectedValue(new Error("403 deleteFiles"));

        await expect(service().removeExpired()).resolves.toBe(0);

        expect(rows.map(({ id }) => id)).toEqual(["a-1"]);
      });

      it("keeps the row, and its upload, when the abort fails, to try again", async () => {
        rows = [
          {
            id: "a-1",
            storage_prefix: prefix("2026-10-01", "a-1"),
            upload_id: "upload-1",
            expired: true,
          },
        ];
        s3.abortMultipartUpload.mockRejectedValue(
          Object.assign(new Error("SlowDown"), { name: "SlowDown" }),
        );

        await expect(service().removeExpired()).resolves.toBe(0);

        expect(s3.removePrefixStrictly).not.toHaveBeenCalled();
        expect(rows.map(({ id }) => id)).toEqual(["a-1"]);
      });

      it("forgets the upload once it is aborted, so a failed sweep does not abort it twice", async () => {
        rows = [
          {
            id: "a-1",
            storage_prefix: prefix("2026-10-01", "a-1"),
            upload_id: "upload-1",
            expired: true,
          },
        ];
        s3.removePrefixStrictly.mockRejectedValue(new Error("403 deleteFiles"));

        await service().removeExpired();

        expect(order).toContain("aborted:a-1");
        expect(rows.map(({ id }) => id)).toEqual(["a-1"]);
      });

      // A row whose expiry moved on after it was picked up must survive.
      it("only deletes a row that is still due and has no upload left", async () => {
        rows = [
          {
            id: "a-1",
            storage_prefix: prefix("2026-10-01", "a-1"),
            upload_id: null,
            expired: true,
          },
        ];

        await service().removeExpired();

        const sql = postgres.query.mock.calls
          .map(([statement]) => statement)
          .find((statement) =>
            statement.includes("DELETE FROM public.chat_attachments"),
          );

        expect(sql).toMatch(/expires_at <= now\(\)/);
        expect(sql).toMatch(/upload_id IS NULL/);
      });

      it("still sweeps a file whose upload was already gone", async () => {
        rows = [
          {
            id: "a-1",
            storage_prefix: prefix("2026-10-01", "a-1"),
            upload_id: "upload-1",
            expired: true,
          },
        ];
        s3.abortMultipartUpload.mockRejectedValue(
          Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" }),
        );

        await expect(service().removeExpired()).resolves.toBe(1);

        expect(rows).toEqual([]);
      });
    });

    describe("the daily sweep", () => {
      const now = new Date("2026-10-10T04:41:00.000Z");

      it("drops a day nothing points at in one delete, without listing it", async () => {
        s3.listPrefixes.mockImplementation(async (value: string) =>
          value === "chat-attachments/rooms/"
            ? ["chat-attachments/rooms/2026-10-01/"]
            : [],
        );

        await service().sweepOrphans(now);

        expect(s3.removePrefixStrictly).toHaveBeenCalledWith(
          "chat-attachments/rooms/2026-10-01/",
        );
        expect(s3.listStream).not.toHaveBeenCalled();
      });

      it("removes only the files no row points at in a day still in use", async () => {
        const day = "chat-attachments/direct/2026-09-01/";
        rows = [
          {
            id: "kept",
            storage_prefix: `${day}kept/`,
            upload_id: null,
            expired: false,
          },
        ];
        s3.listPrefixes.mockImplementation(async (value: string) =>
          value === "chat-attachments/direct/" ? [day] : [],
        );
        s3.listStream.mockImplementation(async function* () {
          yield { name: `${day}kept/file`, size: 1 };
          yield { name: `${day}kept/poster`, size: 1 };
          yield { name: `${day}stray/file`, size: 1 };
        });

        await service().sweepOrphans(now);

        expect(s3.listStream).toHaveBeenCalledWith(day);
        expect(s3.removePrefixStrictly.mock.calls).toEqual([[`${day}stray/`]]);
      });

      it("leaves today and yesterday alone while uploads may still land", async () => {
        s3.listPrefixes.mockImplementation(async (value: string) =>
          value === "chat-attachments/rooms/"
            ? [
                "chat-attachments/rooms/2026-10-09/",
                "chat-attachments/rooms/2026-10-10/",
              ]
            : [],
        );

        await service().sweepOrphans(now);

        expect(s3.removePrefixStrictly).not.toHaveBeenCalled();
        expect(s3.listStream).not.toHaveBeenCalled();
      });

      it("carries on to the next day when one cannot be swept", async () => {
        s3.listPrefixes.mockImplementation(async (value: string) =>
          value === "chat-attachments/rooms/"
            ? [
                "chat-attachments/rooms/2026-10-01/",
                "chat-attachments/rooms/2026-10-02/",
              ]
            : [],
        );
        s3.removePrefixStrictly.mockImplementation(async (value: string) => {
          if (value.includes("2026-10-01")) {
            throw new Error("AccessDenied");
          }
          return 1;
        });

        await expect(service().sweepOrphans(now)).resolves.toBe(1);

        expect(s3.removePrefixStrictly.mock.calls.map(([day]) => day)).toEqual([
          "chat-attachments/rooms/2026-10-01/",
          "chat-attachments/rooms/2026-10-02/",
        ]);
      });

      it("ignores anything under the prefix that is not a day", async () => {
        s3.listPrefixes.mockImplementation(async (value: string) =>
          value === "chat-attachments/rooms/"
            ? ["chat-attachments/rooms/../", "chat-attachments/rooms/x/"]
            : [],
        );

        await service().sweepOrphans(now);

        expect(s3.removePrefixStrictly).not.toHaveBeenCalled();
      });
    });
  });
});
