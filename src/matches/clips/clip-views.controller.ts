import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ClipsService } from "./clips.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";

@Controller("clip-views")
export class ClipViewsController {
  constructor(
    private readonly clips: ClipsService,
    private readonly logger: Logger,
  ) {}

  @Post("play")
  @HttpCode(200)
  public async play(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { file?: string },
  ) {
    const secret = process.env.S3_SECRET;
    const provided = authorization?.replace(/^Bearer\s+/i, "");
    if (!secret || !timingSafeStringEqual(provided, secret)) {
      throw new UnauthorizedException();
    }

    const file = body?.file;
    if (!file || !/^clips\/.+\.mp4$/.test(file)) {
      return { success: false };
    }

    await this.clips.incrementClipViewsByFile(file);
    return { success: true };
  }
}
