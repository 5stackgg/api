import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Request, Response } from "express";
import { SteamGuard } from "src/auth/strategies/SteamGuard";
import { User } from "src/auth/types/User";
import { ChatService } from "./chat.service";
import { ChatAttachmentsService } from "./chat-attachments.service";
import { ChatGifsService } from "./chat-gifs.service";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";

// Uploads go through the api in parts rather than to storage directly: each
// part is a request well under Cloudflare's 100 MB cap, and nothing needs the
// bucket to answer a browser's CORS preflight.
@Controller("chat")
export class ChatMediaController {
  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private static readonly STATUS: Partial<Record<ChatErrorCode, HttpStatus>> = {
    [ChatErrorCode.NotAllowed]: HttpStatus.FORBIDDEN,
    [ChatErrorCode.Gagged]: HttpStatus.FORBIDDEN,
    [ChatErrorCode.NotFound]: HttpStatus.NOT_FOUND,
    [ChatErrorCode.Disabled]: HttpStatus.NOT_FOUND,
    [ChatErrorCode.TooLarge]: HttpStatus.PAYLOAD_TOO_LARGE,
    [ChatErrorCode.UnsupportedType]: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    [ChatErrorCode.TooManyPending]: HttpStatus.TOO_MANY_REQUESTS,
    [ChatErrorCode.QuotaExceeded]: HttpStatus.TOO_MANY_REQUESTS,
    [ChatErrorCode.RateLimited]: HttpStatus.TOO_MANY_REQUESTS,
    [ChatErrorCode.Unavailable]: HttpStatus.BAD_GATEWAY,
    [ChatErrorCode.Busy]: HttpStatus.SERVICE_UNAVAILABLE,
  };

  constructor(
    private readonly chat: ChatService,
    private readonly attachments: ChatAttachmentsService,
    private readonly gifs: ChatGifsService,
  ) {}

  private static fail(code: ChatErrorCode): never {
    throw new HttpException(
      { code },
      ChatMediaController.STATUS[code] ?? HttpStatus.BAD_REQUEST,
    );
  }

  private static attachmentId(id: string): string {
    if (!ChatMediaController.UUID.test(id)) {
      ChatMediaController.fail(ChatErrorCode.NotFound);
    }

    return id;
  }

  // Anything but a raw body is read by one of the app's body parsers first,
  // and the stream handed on would already have ended. The length is what the
  // body is held to, so a request that does not give one is refused.
  private static rawLength(request: Request, max: number): number {
    if (!request.is("application/octet-stream")) {
      throw new HttpException(
        { code: ChatErrorCode.UnsupportedType },
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }

    const declared = Number(request.headers["content-length"]);

    if (!Number.isSafeInteger(declared) || declared <= 0) {
      throw new HttpException(
        { code: ChatErrorCode.Invalid },
        HttpStatus.LENGTH_REQUIRED,
      );
    }

    if (declared > max) {
      ChatMediaController.fail(ChatErrorCode.TooLarge);
    }

    return declared;
  }

  @Get("attachments/config")
  @UseGuards(SteamGuard)
  public async config() {
    return {
      max_files: ChatAttachmentsService.MAX_PER_MESSAGE,
      max_file_bytes: await this.attachments.maxFileBytes(),
      part_size: ChatAttachmentsService.PART_SIZE,
      mime_types: Object.keys(ChatAttachmentsService.TYPES),
      gifs: await this.gifs.enabled(),
    };
  }

  @Post("attachments")
  @UseGuards(SteamGuard)
  public async create(
    @Req() request: Request,
    @Body()
    body: {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      size?: unknown;
      mime_type?: unknown;
      width?: unknown;
      height?: unknown;
      duration_ms?: unknown;
    },
  ) {
    const user = request.user as User;

    if (
      !Object.values(ChatLobbyType).includes(body?.type as ChatLobbyType) ||
      typeof body.id !== "string"
    ) {
      ChatMediaController.fail(ChatErrorCode.Invalid);
    }

    const type = body.type as ChatLobbyType;

    const refusal = await this.chat.attachmentRefusal(type, body.id, user);

    if (refusal) {
      ChatMediaController.fail(refusal);
    }

    const created = await this.attachments.create(
      String(user.steam_id),
      type,
      body.id,
      body,
    );

    if ("code" in created) {
      ChatMediaController.fail(created.code);
    }

    return created;
  }

  @Put("attachments/:id/parts/:part")
  @UseGuards(SteamGuard)
  public async part(
    @Req() request: Request,
    @Param("id") id: string,
    @Param("part") part: string,
  ) {
    const attachmentId = ChatMediaController.attachmentId(id);

    const length = ChatMediaController.rawLength(
      request,
      ChatAttachmentsService.PART_SIZE,
    );

    const refusal = await this.attachments.uploadPart(
      String((request.user as User).steam_id),
      attachmentId,
      Number(part),
      request,
      length,
    );

    if (refusal) {
      ChatMediaController.fail(refusal);
    }

    return { success: true };
  }

  @Post("attachments/:id/complete")
  @UseGuards(SteamGuard)
  public async complete(@Req() request: Request, @Param("id") id: string) {
    const completed = await this.attachments.complete(
      String((request.user as User).steam_id),
      ChatMediaController.attachmentId(id),
    );

    if ("code" in completed) {
      ChatMediaController.fail(completed.code);
    }

    return completed;
  }

  @Put("attachments/:id/poster")
  @UseGuards(SteamGuard)
  public async setPoster(@Req() request: Request, @Param("id") id: string) {
    const attachmentId = ChatMediaController.attachmentId(id);

    const length = ChatMediaController.rawLength(
      request,
      ChatAttachmentsService.POSTER_MAX_BYTES,
    );

    const refusal = await this.attachments.setPoster(
      String((request.user as User).steam_id),
      attachmentId,
      request,
      length,
    );

    if (refusal) {
      ChatMediaController.fail(refusal);
    }

    return { success: true };
  }

  @Delete("attachments/:id")
  @UseGuards(SteamGuard)
  public async discard(@Req() request: Request, @Param("id") id: string) {
    await this.attachments.discard(
      String((request.user as User).steam_id),
      ChatMediaController.attachmentId(id),
    );

    return { success: true };
  }

  @Get("attachments/:id")
  @UseGuards(SteamGuard)
  public async file(
    @Req() request: Request,
    @Res() response: Response,
    @Param("id") id: string,
  ) {
    const row = await this.viewable(request, id);

    await this.attachments.stream(
      `${row.storage_prefix}file`,
      row.mime_type,
      ChatAttachmentsService.downloadName(row.file_name, row.mime_type),
      request,
      response,
    );
  }

  @Get("attachments/:id/poster")
  @UseGuards(SteamGuard)
  public async poster(
    @Req() request: Request,
    @Res() response: Response,
    @Param("id") id: string,
  ) {
    const row = await this.viewable(request, id);

    if (!row.poster_mime_type) {
      ChatMediaController.fail(ChatErrorCode.NotFound);
    }

    await this.attachments.stream(
      `${row.storage_prefix}poster`,
      row.poster_mime_type,
      `poster.${row.poster_mime_type.split("/")[1]}`,
      request,
      response,
    );
  }

  // 404 rather than 403, so asking never confirms a file exists.
  private async viewable(request: Request, id: string) {
    const row = await this.attachments.find(
      ChatMediaController.attachmentId(id),
    );

    if (
      !row ||
      !(await this.chat.canViewAttachment(row, request.user as User))
    ) {
      ChatMediaController.fail(ChatErrorCode.NotFound);
    }

    return row;
  }

  @Get("gifs")
  @UseGuards(SteamGuard)
  public async searchGifs(
    @Req() request: Request,
    @Query("q") query?: string,
    @Query("offset") offset?: string,
  ) {
    const page = await this.gifs.search(
      String((request.user as User).steam_id),
      typeof query === "string" ? query : "",
      Number(offset ?? 0),
    );

    switch (page) {
      case "disabled":
        return ChatMediaController.fail(ChatErrorCode.Disabled);
      case "rate_limited":
        return ChatMediaController.fail(ChatErrorCode.RateLimited);
      case "unavailable":
        return ChatMediaController.fail(ChatErrorCode.Unavailable);
      case "busy":
        return ChatMediaController.fail(ChatErrorCode.Busy);
      default:
        return page;
    }
  }
}
