import { Controller, ForbiddenException, Get, Req } from "@nestjs/common";
import { Request } from "express";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { User } from "../auth/types/User";
import { MediaMtxService } from "./mediamtx.service";

// What the media server is carrying right now.
//
// Every feature that touches WebRTC on this deployment -- game streams, player
// cameras, voice, video calls -- shares one MediaMTX instance and one muxed UDP
// port, so this is the only place the load across all of them is visible at
// once. Administrators only: the path names it reports on carry match ids and
// steam ids.
@Controller("mediamtx")
export class MediaMtxController {
  constructor(private readonly mediaMtx: MediaMtxService) {}

  @Get("stats")
  public async stats(@Req() request: Request) {
    const user = request.user as User | undefined;

    if (!user || !isRoleAbove(user.role, "administrator")) {
      throw new ForbiddenException("Administrators only");
    }

    const stats = await this.mediaMtx.stats();

    // Null means MediaMTX did not answer, which the caller must be able to tell
    // apart from an idle one -- an outage drawn as zeroes is worse than a gap.
    return { reachable: stats !== null, stats };
  }
}
