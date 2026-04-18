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
  ParseIntPipe,
  Req,
  Res,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { TrophiesService } from "./trophies.service";
import { User } from "../auth/types/User";

@Controller("trophies")
export class TrophiesController {
  constructor(private readonly trophiesService: TrophiesService) {}

  @Post(":tournamentId/:placement")
  @UseInterceptors(FileInterceptor("file"))
  async upload(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
    @Param("placement", ParseIntPipe) placement: number,
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
    const path = await this.trophiesService.uploadTrophy(
      tournamentId,
      placement,
      user,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete(":tournamentId/:placement")
  async remove(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
    @Param("placement", ParseIntPipe) placement: number,
  ) {
    const user = this.requireUser(request);
    await this.trophiesService.removeTrophy(tournamentId, placement, user);
    return { success: true };
  }

  @Get(":filename")
  async serve(@Param("filename") filename: string, @Res() res: Response) {
    const result = await this.trophiesService.getStream(filename);
    if (!result) {
      throw new NotFoundException("Trophy image not found");
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
