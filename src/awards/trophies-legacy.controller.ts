import { Controller, Get, Param, Res, NotFoundException } from "@nestjs/common";
import { Response } from "express";
import { AwardsService } from "./awards.service";

// Award artwork uploaded before the awards rename is served immutable, so
// links to /trophies/<filename> stay in caches and embeds indefinitely.
@Controller("trophies")
export class TrophiesLegacyController {
  constructor(private readonly awards: AwardsService) {}

  @Get(":filename")
  public async serve(
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      throw new NotFoundException("Award image not found");
    }

    const result = await this.awards.getStream(filename);
    if (!result) {
      throw new NotFoundException("Award image not found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }

    result.stream.pipe(res);
  }
}
