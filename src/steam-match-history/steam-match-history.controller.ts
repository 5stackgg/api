import { createHash } from "crypto";
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Logger,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { User } from "../auth/types/User";
import { DemoParserService } from "../demos/demo-parser.service";
import { MatchImportService } from "./match-import.service";
import { SteamMatchHistoryService } from "./steam-match-history.service";

@Controller("steam-match-history")
export class SteamMatchHistoryController {
  constructor(
    private readonly service: SteamMatchHistoryService,
    private readonly logger: Logger,
    private readonly demoParser: DemoParserService,
    private readonly matchImport: MatchImportService,
  ) {}

  @Post("upload")
  @UseGuards(SteamGuard)
  @UseInterceptors(FileInterceptor("demo"))
  public async uploadDemo(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 500 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ): Promise<{ match_id: string | null; skipped?: string }> {
    if (!request.user) {
      throw new ForbiddenException("authentication required");
    }
    if (request.user.role !== "administrator") {
      throw new ForbiddenException("administrator access required");
    }
    if (!(await this.service.isImportingAllowed())) {
      throw new ForbiddenException("external match imports are disabled");
    }
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException("empty file");
    }
    if (!file.originalname.toLowerCase().endsWith(".dem")) {
      throw new BadRequestException("expected a .dem file");
    }

    const sha1 = createHash("sha1").update(file.buffer).digest("hex");
    this.logger.log(
      `demo upload steam_id=${request.user.steam_id} sha1=${sha1} bytes=${file.buffer.length}`,
    );

    const parsed = await this.demoParser.parseFromBuffer(
      file.buffer,
      file.originalname,
    );
    if (!parsed) {
      throw new BadRequestException("demo failed to parse");
    }

    const result = await this.matchImport.importExternalDemo(
      parsed,
      "valve",
      sha1,
    );
    return { match_id: result.matchId, skipped: result.skipped };
  }

  @HasuraAction()
  public async linkSteamMatchHistory(data: {
    user: User;
    auth_code: string;
    share_code: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    if (!data.auth_code || !data.share_code) {
      throw new BadRequestException("auth_code and share_code required");
    }

    this.logger.log(
      `action linkSteamMatchHistory steam_id=${data.user.steam_id}`,
    );

    if (!this.service.isEnabled()) {
      return {
        success: false,
        error: "STEAM_WEB_API_KEY not configured on this 5stack instance",
      };
    }

    const result = await this.service.linkAccount(
      data.user.steam_id,
      data.auth_code,
      data.share_code,
    );
    return { success: result.ok, error: result.error };
  }

  @HasuraAction()
  public async unlinkSteamMatchHistory(data: {
    user: User;
  }): Promise<{ success: boolean }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    this.logger.log(
      `action unlinkSteamMatchHistory steam_id=${data.user.steam_id}`,
    );
    await this.service.unlinkAccount(data.user.steam_id);
    return { success: true };
  }

  @HasuraAction()
  public async pollSteamMatchHistory(data: {
    user: User;
  }): Promise<{ success: boolean; collected: number; error?: string }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    this.logger.log(
      `action pollSteamMatchHistory steam_id=${data.user.steam_id}`,
    );

    if (!this.service.isEnabled()) {
      return {
        success: false,
        collected: 0,
        error: "STEAM_WEB_API_KEY not configured",
      };
    }

    const result = await this.service.pollForUser(data.user.steam_id);
    return {
      success: !result.error,
      collected: result.collected,
      error: result.error ?? undefined,
    };
  }

  @HasuraAction()
  public async retryPendingMatchImport(data: {
    user: User;
    valve_match_id: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    if (!data.valve_match_id || !/^\d+$/.test(data.valve_match_id)) {
      throw new BadRequestException("invalid valve_match_id");
    }
    const result = await this.service.retryPendingImport(
      data.user.steam_id,
      data.valve_match_id,
    );
    return { success: result.ok, error: result.error };
  }

  @HasuraAction()
  public async clearPendingMatchImport(data: {
    user: User;
    valve_match_id: string;
  }): Promise<{ success: boolean }> {
    if (!data.user?.steam_id) {
      throw new ForbiddenException("authentication required");
    }
    if (!data.valve_match_id || !/^\d+$/.test(data.valve_match_id)) {
      throw new BadRequestException("invalid valve_match_id");
    }
    const result = await this.service.clearPendingImport(
      data.user.steam_id,
      data.valve_match_id,
    );
    return { success: result.ok };
  }
}
