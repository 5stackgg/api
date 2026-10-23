import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
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
import { BrandingService } from "./branding.service";
import { SteamGuard } from "../auth/strategies/SteamGuard";
import { AdministratorGuard } from "../auth/strategies/AdministratorGuard";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

@Controller("branding")
export class BrandingController {
  constructor(private readonly brandingService: BrandingService) {}

  @Post("upload")
  @UseGuards(SteamGuard, AdministratorGuard)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async upload(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_UPLOAD_BYTES }),
          new FileTypeValidator({
            fileType: /image\/(png|jpeg|svg\+xml|webp|x-icon)/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body("type") type: string,
  ) {
    this.requireAdmin(request);

    if (
      type !== "logo" &&
      type !== "favicon" &&
      type !== "icon" &&
      type !== "banner"
    ) {
      throw new BadRequestException(
        "Type must be 'logo', 'favicon', 'icon' or 'banner'",
      );
    }

    if (type === "icon") {
      if (file.mimetype === "image/x-icon") {
        throw new BadRequestException(
          "App icon must be a PNG, JPEG, WebP or SVG",
        );
      }
      await this.brandingService.uploadAppIcon(file.buffer);
      return { success: true };
    }

    const path = await this.brandingService.uploadFile(
      type,
      file.buffer,
      file.mimetype,
    );

    return { success: true, path };
  }

  @Get("pwa/:size")
  async servePwaIcon(@Param("size") size: string, @Res() res: Response) {
    const result = await this.brandingService.getPwaIcon(Number(size));

    if (!result) {
      throw new NotFoundException("No PWA icon found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    result.stream.pipe(res);
  }

  @Get(":type")
  async serve(@Param("type") type: string, @Res() res: Response) {
    if (type !== "logo" && type !== "favicon" && type !== "banner") {
      throw new NotFoundException();
    }

    const result = await this.brandingService.getFile(type);

    if (!result) {
      throw new NotFoundException("No custom branding found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }

    result.stream.pipe(res);
  }

  @Delete(":type")
  async remove(@Param("type") type: string, @Req() request: Request) {
    this.requireAdmin(request);

    if (
      type !== "logo" &&
      type !== "favicon" &&
      type !== "pwa" &&
      type !== "icon" &&
      type !== "banner"
    ) {
      throw new BadRequestException(
        "Type must be 'logo', 'favicon', 'pwa', 'icon' or 'banner'",
      );
    }

    await this.brandingService.deleteFile(type);
    return { success: true };
  }

  private requireAdmin(request: Request) {
    const user = request.user as any;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    if (user.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }
  }
}
