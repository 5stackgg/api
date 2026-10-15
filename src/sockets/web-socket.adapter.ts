import { INestApplicationContext } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { Server } from "http";

export class WebSocketAdapter extends WsAdapter {
  private static readonly WEB_PATH = "/ws/web";

  constructor(
    appOrHttpServer: INestApplicationContext | Server,
    private readonly allowOrigin: (origin?: string) => boolean,
  ) {
    super(appOrHttpServer);
  }

  // /ws/web signs in with the session cookie, which a browser sends with a
  // socket opened from any site. Browsers always send an Origin on it and
  // nothing else connects there, so a missing one is refused too.
  public create(
    port: number,
    options: Record<string, any> & { path?: string } = {},
  ) {
    if (options.path !== WebSocketAdapter.WEB_PATH) {
      return super.create(port, options);
    }

    return super.create(port, {
      ...options,
      verifyClient: (
        info: { origin?: string },
        done: (verified: boolean, code?: number, message?: string) => void,
      ) => {
        if (info.origin && this.allowOrigin(info.origin)) {
          done(true);
          return;
        }
        done(false, 403, "Forbidden");
      },
    });
  }
}
