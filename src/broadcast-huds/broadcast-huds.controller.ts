import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request } from "express";
import { User } from "src/auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { BroadcastHudsService } from "./broadcast-huds.service";

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

@Controller("huds")
export class BroadcastHudsController {
  constructor(private readonly huds: BroadcastHudsService) {}

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
