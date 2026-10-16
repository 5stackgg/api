import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { User } from "../auth/types/User";
import { ExtensionService, FaceitRoom } from "./extension.service";

const MAX_LOOKUP = 50;
const MAX_SHARE_CODES = 20;

// Called from the 5Stack browser extension with the panel's own session
// cookie. The extension's pages hold host permission for the panel, which
// takes them out of CORS and gets the SameSite=Lax cookie sent.
@Controller("extension")
@UseGuards(SteamGuard)
export class ExtensionController {
  constructor(private readonly extension: ExtensionService) {}

  @Get("me")
  public async me(@Req() request: Request) {
    const user = this.user(request);
    return {
      steam_id: user.steam_id,
      name: user.name,
      avatar_url: user.avatar_url ?? null,
      role: user.role,
      imports: {
        ...(await this.extension.imports()),
        anyone: ExtensionService.canImportAnyone(user),
      },
      faceit: await this.extension.faceitAccount(user.steam_id),
    };
  }

  @Post("logout")
  public async logout(@Req() request: Request) {
    this.user(request);
    await new Promise<void>((resolve, reject) =>
      request.session.destroy((error) => (error ? reject(error) : resolve())),
    );
    return { success: true };
  }

  @Post("lookup")
  public async lookup(
    @Req() request: Request,
    @Body() body: { faceit?: Array<FaceitRoom>; valve?: Array<string> },
  ) {
    this.user(request);
    const faceit = body?.faceit ?? [];
    const valve = body?.valve ?? [];
    if (
      !Array.isArray(faceit) ||
      !Array.isArray(valve) ||
      faceit.length + valve.length > MAX_LOOKUP
    ) {
      throw new BadRequestException(`look up at most ${MAX_LOOKUP} matches`);
    }
    if (!faceit.every((room) => ExtensionService.isFaceitMatchId(room?.id))) {
      throw new BadRequestException("invalid FACEIT match id");
    }
    if (!valve.every((code) => typeof code === "string")) {
      throw new BadRequestException("invalid share code");
    }

    return {
      faceit: await this.extension.lookupFaceit(faceit),
      valve: await this.extension.lookupValve(valve),
    };
  }

  @Post("faceit")
  public async importFaceit(
    @Req() request: Request,
    @Body() body: { match_id?: string; url?: string },
  ) {
    const user = this.user(request);
    if (!(await this.extension.imports()).faceit) {
      throw new ForbiddenException("FACEIT imports are off on this panel");
    }

    if (!ExtensionService.isFaceitMatchId(body?.match_id)) {
      throw new BadRequestException("invalid FACEIT match id");
    }
    const matchId = body.match_id.toLowerCase();
    if (typeof body.url !== "string") {
      throw new BadRequestException("invalid demo url");
    }

    return this.extension.queueFaceitDemo(user, {
      matchId,
      url: body.url,
    });
  }

  @Post("valve")
  public async importValve(
    @Req() request: Request,
    @Body() body: { share_codes?: Array<string> },
  ) {
    const user = this.user(request);
    if (!(await this.extension.imports()).valve) {
      throw new ForbiddenException("Valve imports are off on this panel");
    }

    const shareCodes = body?.share_codes;
    if (
      !Array.isArray(shareCodes) ||
      shareCodes.length === 0 ||
      shareCodes.length > MAX_SHARE_CODES ||
      !shareCodes.every((code) => typeof code === "string")
    ) {
      throw new BadRequestException(
        `send between 1 and ${MAX_SHARE_CODES} share codes`,
      );
    }

    return {
      valve: await this.extension.queueShareCodes(user.steam_id, shareCodes),
    };
  }

  private user(request: Request): User {
    if (!request.user) {
      throw new ForbiddenException("authentication required");
    }
    return request.user;
  }
}
