import { Controller, Get, Request, Response } from "@nestjs/common";
import { resolve4 } from "dns/promises";

@Controller("quick-connect")
export class QuickConnectController {
  @Get()
  public async quickConnect(@Request() request, @Response() response) {
    let link: string = request.query.link as string;

    const host = link.match(/steam:\/\/connect\/(.*):/)?.[1];

    if (!host) {
      return response.status(500);
    }

    const [address] = await resolve4(host);

    link = link.replace(host, address);

    return response.redirect(307, link);
  }
}
