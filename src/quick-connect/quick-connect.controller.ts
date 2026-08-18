import { Request, Response } from "express";
import { Controller, Get, Req, Res } from "@nestjs/common";

// Discord's link buttons only accept http(s) urls, and a match's
// connection_link is a steam:// one (see
// hasura/functions/match/get_match_connection.sql), so the button points here
// and this bounces the browser the rest of the way.
//
// Must match the `/quick-connect` path whitelisted for the api on WEB_DOMAIN in
// 5stack-panel/base/api/ingress.yaml -- everything else on that host falls
// through to Nuxt, which is where this used to land.
@Controller("quick-connect")
export class QuickConnectController {
  @Get()
  public async quickConnect(
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const link = String(request.query.link ?? "");

    // The link arrives in a query string anyone can author, and is about to
    // become a navigation on the domain the auth cookie is scoped to. steam://
    // is the only thing this page exists to reach: without the check it
    // forwards to any site given to it, javascript: urls included, and those
    // run.
    if (!link.startsWith("steam://")) {
      response.status(400).send("Invalid connect link");
      return;
    }

    // JSON.stringify escapes quotes and backslashes but not `</script>` -- the
    // html parser ends the element on that sequence wherever it appears,
    // inside a string literal or not. Escaping `<` is what keeps the link in
    // the script rather than after it.
    const target = JSON.stringify(link).replaceAll("<", "\\u003c");

    response.send(`
      <html>
        <body>
          <script>
            window.location.href = ${target};
            setTimeout(() => window.close(), 10);
          </script>
        </body>
      </html>
    `);
  }
}
