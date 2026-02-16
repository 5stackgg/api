import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  UploadedFile,
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

@Controller("branding")
export class BrandingController {
  constructor(private readonly brandingService: BrandingService) {}

  @Post("upload")
  @UseInterceptors(FileInterceptor("file"))
  async upload(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
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

    if (type !== "logo" && type !== "favicon") {
      throw new BadRequestException("Type must be 'logo' or 'favicon'");
    }

    const path = await this.brandingService.uploadFile(
      type,
      file.buffer,
      file.mimetype,
    );

    return { success: true, path };
  }

  @Get(":type")
  async serve(
    @Param("type") type: string,
    @Res() res: Response,
  ) {
    if (type !== "logo" && type !== "favicon") {
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
  async remove(
    @Param("type") type: string,
    @Req() request: Request,
  ) {
    this.requireAdmin(request);

    if (type !== "logo" && type !== "favicon") {
      throw new BadRequestException("Type must be 'logo' or 'favicon'");
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
