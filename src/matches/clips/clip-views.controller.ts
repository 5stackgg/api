import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ClipsService } from "./clips.service";
import { timingSafeStringEqual } from "../../utilities/timingSafeStringEqual";

@Controller("clip-views")
export class ClipViewsController {
  constructor(private readonly clips: ClipsService) {}

  @Post("play")
  @HttpCode(200)
  public async play(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { file?: string; clientKey?: string },
  ) {
    const secret = process.env.S3_SECRET;
    const provided = authorization?.replace(/^Bearer\s+/i, "");
    if (!secret || !timingSafeStringEqual(provided, secret)) {
      throw new UnauthorizedException();
    }

    const file = body?.file;
    const clientKey = body?.clientKey;
    if (
      !file ||
      !/^clips\/.+\.mp4$/.test(file) ||
      !clientKey ||
      !/^[a-f0-9]{1,64}$/.test(clientKey)
    ) {
      return { success: false };
    }

    const counted = await this.clips.registerStreamedClipView(file, clientKey);
    return { success: true, counted };
  }
}
