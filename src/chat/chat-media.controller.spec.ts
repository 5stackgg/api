import { HttpException } from "@nestjs/common";
import { Readable } from "stream";
import { ChatMediaController } from "./chat-media.controller";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatGifsService } from "./chat-gifs.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

const ID = "0b7d6c1e-1111-4a2b-9c3d-000000000001";
const ME = "76561198000000001";
const OTHER = "76561198000000002";

describe("ChatMediaController", () => {
  const chat = {
    attachmentRefusal: jest.fn(),
    canViewAttachment: jest.fn(),
  };

  const attachments = {
    maxFileBytes: jest.fn(),
    create: jest.fn(),
    uploadPart: jest.fn(),
    complete: jest.fn(),
    setPoster: jest.fn(),
    discard: jest.fn(),
    find: jest.fn(),
    stream: jest.fn(),
  };

  const gifs = {
    enabled: jest.fn(),
    search: jest.fn(),
  };

  let controller: ChatMediaController;

  const request = (
    steamId: string | undefined = ME,
    overrides: Record<string, unknown> = {},
  ) =>
    ({
      user: steamId
        ? { steam_id: steamId, role: "user", name: "Someone" }
        : undefined,
      headers: {},
      is: jest.fn(() => "application/octet-stream"),
      ...overrides,
    }) as any;

  const body = (bytes: Buffer, contentType = "application/octet-stream") =>
    Object.assign(Readable.from([bytes]), {
      user: { steam_id: ME, role: "user", name: "Someone" },
      headers: { "content-length": String(bytes.length) },
      is: (type: string) => (type === contentType ? type : false),
    }) as any;

  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      return {
        status: (error as HttpException).getStatus(),
        body: (error as HttpException).getResponse(),
      };
    }
    throw new Error("expected a refusal");
  };

  beforeEach(() => {
    jest.clearAllMocks();
    attachments.maxFileBytes.mockResolvedValue(100 * 1024 * 1024);
    gifs.enabled.mockResolvedValue(true);
    chat.attachmentRefusal.mockResolvedValue(null);
    controller = new ChatMediaController(
      chat as any,
      attachments as any,
      gifs as any,
    );
  });

  describe("config", () => {
    it("tells the composer the operator's limits and whether GIFs are on", async () => {
      await expect(controller.config()).resolves.toEqual({
        max_files: 4,
        max_file_bytes: 100 * 1024 * 1024,
        part_size: ChatAttachmentsService.PART_SIZE,
        mime_types: Object.keys(ChatAttachmentsService.TYPES),
        gifs: true,
      });
    });

    it("never hands out the GIPHY key", async () => {
      const KEY = "giphy-secret-key";
      const realGifs = new ChatGifsService(
        { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any,
        { query: jest.fn(async () => [{ value: KEY }]) } as any,
        { getConnection: () => ({}) } as any,
      );

      const config = await new ChatMediaController(
        chat as any,
        attachments as any,
        realGifs,
      ).config();

      expect(config.gifs).toBe(true);
      expect(JSON.stringify(config)).not.toContain(KEY);
    });
  });

  describe("starting an upload", () => {
    const upload = {
      type: ChatLobbyType.MatchMaking,
      id: "lobby-1",
      name: "smoke.png",
      size: 1024,
      mime_type: "image/png",
    };

    it("refuses a room the player may not post in, before storing anything", async () => {
      chat.attachmentRefusal.mockResolvedValue(ChatErrorCode.NotAllowed);

      await expect(
        failure(controller.create(request(), upload)),
      ).resolves.toEqual({
        status: 403,
        body: { code: ChatErrorCode.NotAllowed },
      });
      expect(attachments.create).not.toHaveBeenCalled();
    });

    it("refuses a gagged player", async () => {
      chat.attachmentRefusal.mockResolvedValue(ChatErrorCode.Gagged);

      await expect(
        failure(controller.create(request(), upload)),
      ).resolves.toMatchObject({ status: 403, body: { code: "gagged" } });
    });

    it("refuses a room type it does not know", async () => {
      await expect(
        failure(controller.create(request(), { ...upload, type: "global" })),
      ).resolves.toMatchObject({ status: 400 });
      expect(chat.attachmentRefusal).not.toHaveBeenCalled();
    });

    it("says why a file was refused", async () => {
      attachments.create.mockResolvedValue({ code: ChatErrorCode.TooLarge });

      await expect(
        failure(controller.create(request(), upload)),
      ).resolves.toEqual({ status: 413, body: { code: "too_large" } });
    });

    it("starts the upload as the signed in player", async () => {
      attachments.create.mockResolvedValue({ id: ID, part_size: 1, parts: 1 });

      await expect(controller.create(request(), upload)).resolves.toEqual({
        id: ID,
        part_size: 1,
        parts: 1,
      });
      expect(attachments.create).toHaveBeenCalledWith(
        ME,
        ChatLobbyType.MatchMaking,
        "lobby-1",
        upload,
      );
    });
  });

  describe("parts", () => {
    it("hands the request's stream to storage, with the length it declared", async () => {
      attachments.uploadPart.mockResolvedValue(null);
      const req = body(Buffer.from("part one"));

      await expect(controller.part(req, ID, "1")).resolves.toEqual({
        success: true,
      });
      expect(attachments.uploadPart).toHaveBeenCalledWith(ME, ID, 1, req, 8);
    });

    it("refuses a part that does not say how long it is", async () => {
      const req = body(Buffer.from("x"));
      delete req.headers["content-length"];

      await expect(
        failure(controller.part(req, ID, "1")),
      ).resolves.toMatchObject({ status: 411 });
      expect(attachments.uploadPart).not.toHaveBeenCalled();
    });

    it("answers 429 when too many parts are already on their way", async () => {
      attachments.uploadPart.mockResolvedValue(ChatErrorCode.RateLimited);

      await expect(
        failure(controller.part(body(Buffer.from("x")), ID, "1")),
      ).resolves.toEqual({ status: 429, body: { code: "rate_limited" } });
    });

    // Anything else is read by a body parser first, and the stream this
    // waits on has already ended.
    it("only takes a raw body", async () => {
      await expect(
        failure(
          controller.part(body(Buffer.from("{}"), "application/json"), ID, "1"),
        ),
      ).resolves.toMatchObject({ status: 415 });
      expect(attachments.uploadPart).not.toHaveBeenCalled();
    });

    it("refuses a part bigger than any part can be, without reading it all", async () => {
      const huge = body(Buffer.alloc(16));
      huge.headers["content-length"] = String(
        ChatAttachmentsService.PART_SIZE + 1,
      );

      await expect(
        failure(controller.part(huge, ID, "1")),
      ).resolves.toMatchObject({ status: 413 });
      expect(attachments.uploadPart).not.toHaveBeenCalled();
    });

    it("refuses an attachment id that is not one", async () => {
      await expect(
        failure(controller.part(body(Buffer.from("x")), "../x", "1")),
      ).resolves.toMatchObject({ status: 404 });
    });

    it("passes on why storage refused the part", async () => {
      attachments.uploadPart.mockResolvedValue(ChatErrorCode.UnsupportedType);

      await expect(
        failure(controller.part(body(Buffer.from("x")), ID, "1")),
      ).resolves.toEqual({ status: 415, body: { code: "unsupported_type" } });
    });
  });

  describe("posters", () => {
    it("hands the poster's stream to storage, with the length it declared", async () => {
      attachments.setPoster.mockResolvedValue(null);
      const req = body(Buffer.from("RIFF0000WEBP"));

      await expect(controller.setPoster(req, ID)).resolves.toEqual({
        success: true,
      });
      expect(attachments.setPoster).toHaveBeenCalledWith(ME, ID, req, 12);
    });

    it("refuses a poster bigger than a poster can be, without reading it", async () => {
      const req = body(Buffer.alloc(16));
      req.headers["content-length"] = String(
        ChatAttachmentsService.POSTER_MAX_BYTES + 1,
      );

      await expect(
        failure(controller.setPoster(req, ID)),
      ).resolves.toMatchObject({ status: 413 });
      expect(attachments.setPoster).not.toHaveBeenCalled();
    });
  });

  describe("serving", () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: ID,
      uploader_steam_id: ME,
      room_type: ChatLobbyType.MatchMaking,
      room_id: "lobby-1",
      message_id: "m-1",
      storage_prefix: `chat-attachments/rooms/2026-10-02/${ID}/`,
      mime_type: "image/png",
      poster_mime_type: null as string | null,
      file_name: "smoke.png",
      ...overrides,
    });

    const response = () => ({}) as any;

    it("answers 404 to anyone chat would not show the file to", async () => {
      const req = request(OTHER);
      attachments.find.mockResolvedValue(row());
      chat.canViewAttachment.mockResolvedValue(false);

      await expect(
        failure(controller.file(req, response(), ID)),
      ).resolves.toMatchObject({ status: 404 });
      expect(chat.canViewAttachment).toHaveBeenCalledWith(row(), req.user);
      expect(attachments.stream).not.toHaveBeenCalled();
    });

    it("answers 404 for a file there is no row for", async () => {
      attachments.find.mockResolvedValue(undefined);

      await expect(
        failure(controller.file(request(ME), response(), ID)),
      ).resolves.toMatchObject({ status: 404 });
      expect(chat.canViewAttachment).not.toHaveBeenCalled();
    });

    it("streams the file under a name that matches what it is", async () => {
      const req = request(OTHER);
      const res = response();
      attachments.find.mockResolvedValue(row({ mime_type: "image/jpeg" }));
      chat.canViewAttachment.mockResolvedValue(true);

      await controller.file(req, res, ID);

      expect(attachments.stream).toHaveBeenCalledWith(
        `chat-attachments/rooms/2026-10-02/${ID}/file`,
        "image/jpeg",
        "smoke.jpg",
        req,
        res,
      );
    });

    it("answers 404 for a video without a poster", async () => {
      attachments.find.mockResolvedValue(row({ mime_type: "video/mp4" }));
      chat.canViewAttachment.mockResolvedValue(true);

      await expect(
        failure(controller.poster(request(ME), response(), ID)),
      ).resolves.toMatchObject({ status: 404 });
    });

    it("serves a poster as the image it is", async () => {
      attachments.find.mockResolvedValue(
        row({ mime_type: "video/mp4", poster_mime_type: "image/webp" }),
      );
      chat.canViewAttachment.mockResolvedValue(true);

      await controller.poster(request(ME), response(), ID);

      expect(attachments.stream).toHaveBeenCalledWith(
        `chat-attachments/rooms/2026-10-02/${ID}/poster`,
        "image/webp",
        "poster.webp",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("GIF search", () => {
    it("answers 404 when GIFs are off", async () => {
      gifs.search.mockResolvedValue("disabled");

      await expect(
        failure(controller.searchGifs(request(), "gg", "0")),
      ).resolves.toMatchObject({ status: 404, body: { code: "disabled" } });
    });

    it("answers 429 to a player searching too fast", async () => {
      gifs.search.mockResolvedValue("rate_limited");

      await expect(
        failure(controller.searchGifs(request(), "gg", "0")),
      ).resolves.toMatchObject({ status: 429 });
    });

    it("says GIFs are busy when the panel's GIPHY allowance is spent", async () => {
      gifs.search.mockResolvedValue("busy");

      await expect(
        failure(controller.searchGifs(request(), "gg", "0")),
      ).resolves.toEqual({ status: 503, body: { code: "busy" } });
    });

    it("searches as the signed in player", async () => {
      gifs.search.mockResolvedValue({ results: [], next: null });

      await expect(
        controller.searchGifs(request(), "gg", "24"),
      ).resolves.toEqual({ results: [], next: null });
      expect(gifs.search).toHaveBeenCalledWith(ME, "gg", 24);
    });
  });
});
