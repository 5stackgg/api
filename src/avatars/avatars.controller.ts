import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  Req,
  Res,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { AvatarsService } from "./avatars.service";
import { User } from "../auth/types/User";
import { SteamGuard } from "../auth/strategies/SteamGuard";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BANNER_BYTES = 10 * 1024 * 1024;

// Every distinct URL is its own Cloudflare cache entry and its own resize on a
// miss, so a resize is only served when the raw query string is exactly
// `w=<one of these>`. Checked on the raw string, not the parsed query: `w=64&`,
// `w=6%34` and `%77=64` all parse to the same {w:"64"} while being different
// URLs, each one an uncached resize.
export const AVATAR_WIDTHS = [32, 64, 128, 256, 512, 1024, 1920];

@Controller("avatars")
export class AvatarsController {
  constructor(private readonly avatarsService: AvatarsService) {}

  @Post("teams/:teamId")
  @UseGuards(SteamGuard)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async uploadTeam(
    @Req() request: Request,
    @Param("teamId") teamId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_IMAGE_BYTES }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.requireUser(request);
    const path = await this.avatarsService.uploadTeamAvatar(
      teamId,
      user,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete("teams/:teamId")
  async removeTeam(@Req() request: Request, @Param("teamId") teamId: string) {
    const user = this.requireUser(request);
    await this.avatarsService.removeTeamAvatar(teamId, user);
    return { success: true };
  }

  @Post("players/:steamId")
  @UseGuards(SteamGuard)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async uploadPlayer(
    @Req() request: Request,
    @Param("steamId") steamId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_IMAGE_BYTES }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.requireUser(request);
    const path = await this.avatarsService.uploadPlayerAvatar(
      steamId,
      user,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete("players/:steamId")
  async removePlayer(
    @Req() request: Request,
    @Param("steamId") steamId: string,
  ) {
    const user = this.requireUser(request);
    await this.avatarsService.removePlayerAvatar(steamId, user);
    return { success: true };
  }

  @Post("roster-players/:steamId")
  @UseGuards(SteamGuard)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async uploadPlayerRoster(
    @Req() request: Request,
    @Param("steamId") steamId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_IMAGE_BYTES }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.requireUser(request);
    const path = await this.avatarsService.uploadPlayerRosterImage(
      steamId,
      user,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete("roster-players/:steamId")
  async removePlayerRoster(
    @Req() request: Request,
    @Param("steamId") steamId: string,
  ) {
    const user = this.requireUser(request);
    await this.avatarsService.removePlayerRosterImage(steamId, user);
    return { success: true };
  }

  @Post("roster-teams/:teamId/:steamId")
  @UseGuards(SteamGuard)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async uploadTeamRosterPlayer(
    @Req() request: Request,
    @Param("teamId") teamId: string,
    @Param("steamId") steamId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_IMAGE_BYTES }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.requireUser(request);
    const path = await this.avatarsService.uploadTeamRosterPlayerImage(
      teamId,
      steamId,
      user,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete("roster-teams/:teamId/:steamId")
  async removeTeamRosterPlayer(
    @Req() request: Request,
    @Param("teamId") teamId: string,
    @Param("steamId") steamId: string,
  ) {
    const user = this.requireUser(request);
    await this.avatarsService.removeTeamRosterPlayerImage(
      teamId,
      steamId,
      user,
    );
    return { success: true };
  }

  @Post("tournaments/:tournamentId")
  @UseGuards(SteamGuard)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  async uploadTournament(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_IMAGE_BYTES }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.requireUser(request);
    const path = await this.avatarsService.uploadTournamentLogo(
      tournamentId,
      user,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete("tournaments/:tournamentId")
  async removeTournament(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
  ) {
    const user = this.requireUser(request);
    await this.avatarsService.removeTournamentLogo(tournamentId, user);
    return { success: true };
  }

  @Post("tournaments/:tournamentId/banner")
  @UseGuards(SteamGuard)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_BANNER_BYTES } }),
  )
  async uploadTournamentBanner(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_BANNER_BYTES }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.requireUser(request);
    const path = await this.avatarsService.uploadTournamentBanner(
      tournamentId,
      user,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete("tournaments/:tournamentId/banner")
  async removeTournamentBanner(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
  ) {
    const user = this.requireUser(request);
    await this.avatarsService.removeTournamentBanner(tournamentId, user);
    return { success: true };
  }

  @Get("teams/:filename")
  async serveTeam(
    @Param("filename") filename: string,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    return this.serve("teams", filename, request, res);
  }

  @Get("players/:filename")
  async servePlayer(
    @Param("filename") filename: string,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    return this.serve("players", filename, request, res);
  }

  @Get("roster-players/:filename")
  async serveRosterPlayer(
    @Param("filename") filename: string,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    return this.serve("roster-players", filename, request, res);
  }

  @Get("roster-teams/:filename")
  async serveRosterTeam(
    @Param("filename") filename: string,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    return this.serve("roster-teams", filename, request, res);
  }

  @Get("tournaments/:filename")
  async serveTournament(
    @Param("filename") filename: string,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    return this.serve("tournaments", filename, request, res);
  }

  private async serve(
    kind:
      | "teams"
      | "players"
      | "roster-players"
      | "roster-teams"
      | "tournaments",
    filename: string,
    request: Request,
    res: Response,
  ) {
    const url = request.originalUrl;
    const width = url.includes("?")
      ? /^w=([1-9]\d*)$/.exec(url.slice(url.indexOf("?") + 1))
      : null;
    if (width || request.query.w !== undefined) {
      const size = width ? Number(width[1]) : 0;
      if (!AVATAR_WIDTHS.includes(size)) {
        throw new BadRequestException(
          `only ?w=<${AVATAR_WIDTHS.join("|")}> is accepted`,
        );
      }

      const resized = await this.avatarsService.getResized(
        kind,
        filename,
        size,
      );
      if (!resized) {
        throw new NotFoundException("Avatar not found");
      }

      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      if (resized.etag) {
        res.setHeader("ETag", resized.etag);
      }
      res.end(resized.image);
      return;
    }

    const result = await this.avatarsService.getStream(kind, filename);
    if (!result) {
      throw new NotFoundException("Avatar not found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }

    result.stream.pipe(res);
  }

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }
}
