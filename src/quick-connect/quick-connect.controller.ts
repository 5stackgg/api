import { Request, Response } from "express";
import { Controller, Get, Req, Res } from "@nestjs/common";
import { resolve4 } from "dns/promises";

@Controller("quick-connect")
export class QuickConnectController {
  @Get()
  public async quickConnect(
    @Req() request: Request,
    @Res() response: Response
  ) {
    let link: string = request.query.link as string;

    const host = link.match(/steam:\/\/connect\/(.*):/)?.[1];

    if (!host) {
      return response.status(500);
    }

    try {
      const [address] = await resolve4(host);
      link = link.replace(host, address);
    } catch(error) {
      console.warn("unable to get address from host", error.message);
    }

    return response.redirect(307, link);
  }
}
