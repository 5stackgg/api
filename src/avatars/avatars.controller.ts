import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  Req,
  Res,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { AvatarsService } from "./avatars.service";
import { User } from "../auth/types/User";

@Controller("avatars")
export class AvatarsController {
  constructor(private readonly avatarsService: AvatarsService) {}

  @Post("teams/:teamId")
  @UseInterceptors(FileInterceptor("file"))
  async uploadTeam(
    @Req() request: Request,
    @Param("teamId") teamId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
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
  @UseInterceptors(FileInterceptor("file"))
  async uploadPlayer(
    @Req() request: Request,
    @Param("steamId") steamId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
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

  @Get("teams/:filename")
  async serveTeam(@Param("filename") filename: string, @Res() res: Response) {
    return this.serve("teams", filename, res);
  }

  @Get("players/:filename")
  async servePlayer(@Param("filename") filename: string, @Res() res: Response) {
    return this.serve("players", filename, res);
  }

  private async serve(
    kind: "teams" | "players",
    filename: string,
    res: Response,
  ) {
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
