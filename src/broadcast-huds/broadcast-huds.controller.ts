import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  MaxFileSizeValidator,
  NotFoundException,
  Param,
  ParseFilePipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { User } from "src/auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { BroadcastHudsService } from "./broadcast-huds.service";

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

@Controller("huds")
export class BroadcastHudsController {
  constructor(private readonly huds: BroadcastHudsService) {}

  // Unauthenticated, and deliberately so: this is fetched by JTs Hud Manager
  // running inside the game-streamer pod, which holds no 5stack session. It
  // serves nothing but an archive an administrator uploaded -- no player data
  // -- which is why /hud-data/:matchId next door stays cluster-internal and
  // this does not have to.
  @Get(":slug/bundle.zip")
  public async bundle(@Param("slug") slug: string, @Res() response: Response) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new NotFoundException("no such hud");
    }

    const bundle = await this.huds.bundle(slug);
    if (!bundle) {
      throw new NotFoundException("no such hud");
    }

    response.setHeader("Content-Type", "application/zip");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${slug}.zip"`,
    );
    if (bundle.size > 0) {
      response.setHeader("Content-Length", String(bundle.size));
    }
    // The bundle at a given slug never changes -- a re-import mints a new slug
    // -- so a pod re-fetching one can be told not to bother.
    response.setHeader("Cache-Control", "public, max-age=3600");

    bundle.stream.pipe(response);
  }

  @Post("import")
  @UseInterceptors(FileInterceptor("hud"))
  public async import(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: MAX_UPLOAD_BYTES })],
      }),
    )
    file: Express.Multer.File,
  ) {
    this.requireAdmin(request);

    if (!file?.buffer?.length) {
      throw new BadRequestException("no archive uploaded");
    }

    const user = request.user as User;
    const hud = await this.huds.import(
      file.buffer,
      file.originalname ?? "hud.zip",
      user.steam_id,
    );

    return { success: true, hud };
  }

  @Delete(":slug")
  public async remove(@Req() request: Request, @Param("slug") slug: string) {
    this.requireAdmin(request);
    await this.huds.remove(slug);
    return { success: true };
  }

  private requireAdmin(request: Request) {
    const user = request.user as User | undefined;
    if (!user || !isRoleAbove(user.role, "administrator")) {
      throw new ForbiddenException();
    }
  }
}
