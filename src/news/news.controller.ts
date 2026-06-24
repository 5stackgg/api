import {
  Controller,
  Post,
  Get,
  Param,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { SystemService } from "src/system/system.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { User } from "../auth/types/User";
import { e_player_roles_enum } from "generated";
import { NewsService } from "./news.service";

@Controller("news")
export class NewsController {
  constructor(
    private readonly news: NewsService,
    private readonly system: SystemService,
  ) {}

  @HasuraAction()
  public async newsPostsAdmin(data: { user?: User }) {
    await this.assertCanPost(data.user);
    return await this.news.listPosts();
  }

  @HasuraAction()
  public async newsPostAdmin(data: { id: string; user?: User }) {
    await this.assertCanPost(data.user);
    return await this.news.getPost(data.id);
  }

  @HasuraAction()
  public async saveNewsPost(data: {
    id?: string | null;
    title: string;
    teaser?: string | null;
    cover_image_url?: string | null;
    content_markdown: string;
    user?: User;
  }) {
    const user = await this.assertCanPost(data.user);
    return await this.news.savePost(
      {
        id: data.id,
        title: data.title,
        teaser: data.teaser,
        cover_image_url: data.cover_image_url,
        content_markdown: data.content_markdown,
      },
      user.steam_id,
    );
  }

  @HasuraAction()
  public async setNewsPostStatus(data: {
    id: string;
    status: string;
    user?: User;
  }) {
    await this.assertCanPost(data.user);
    return await this.news.setStatus(data.id, data.status);
  }

  @HasuraAction()
  public async deleteNewsPost(data: { id: string; user?: User }) {
    await this.assertCanPost(data.user);
    await this.news.deletePost(data.id);
    return { success: true };
  }

  @Post("upload")
  @UseInterceptors(FileInterceptor("file"))
  public async upload(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp|gif)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    await this.assertCanPost(request.user as User | undefined);
    const filename = await this.news.uploadImage(file.buffer, file.mimetype);
    return { success: true, filename };
  }

  @Post(":slug/view")
  public async trackView(@Param("slug") slug: string) {
    await this.news.trackView(slug);
    return { success: true };
  }

  @Get("image/:filename")
  public async serveImage(
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      throw new NotFoundException("Image not found");
    }

    const result = await this.news.getImageStream(filename);
    if (!result) {
      throw new NotFoundException("Image not found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }

    result.stream.pipe(res);
  }

  private async assertCanPost(user?: User): Promise<User> {
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }

    const postRole = (await this.system.getSetting(
      SystemSettingName.PostNewsRole,
      "administrator",
    )) as e_player_roles_enum;

    if (!isRoleAbove(user.role, postRole)) {
      throw new ForbiddenException(
        "You do not have permission to post news",
      );
    }

    return user;
  }
}
