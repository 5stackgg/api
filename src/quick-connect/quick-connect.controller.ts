import { Request, Response } from "express";
import { Controller, Get, Req, Res } from "@nestjs/common";

@Controller("quick-connect")
export class QuickConnectController {
  @Get()
  public async quickConnect(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const link = request.query.link as string;
    return response.send(`
      <html>
        <body>
          <script>
            window.location.href = ${JSON.stringify(link)};
            setTimeout(() => window.close(), 10);
          </script>
        </body>
      </html>
    `);
  }
}
