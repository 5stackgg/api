import zlib from "zlib";
import { promisify } from "util";
import { Request, Response } from "express";
import { Injectable, Logger } from "@nestjs/common";

type Fragment = {
  data?: Buffer;
  gipped: boolean;
  [key: string]: any;
};

@Injectable()
export class MatchRelayService {
  private readonly gzip = promisify(zlib.gzip);

  private readonly broadcasts: {
    [key: string]: {
      start: number;
      fragments: Fragment[];
    };
  } = {};

  constructor(private readonly logger: Logger) {}

  public getStart(response: Response, matchId: string, fragmentIndex: number) {
    const broadcast = this.broadcasts[matchId];

    console.info(`request`, {
      fragmentIndex,
      start_fragment: broadcast?.start,
    });
    if (broadcast?.start == null || broadcast.start != fragmentIndex) {
      return this.relayError(
        response,
        404,
        "Invalid or expired start fragment, please re-sync",
      );
    }

    this.getFragment(response, matchId, fragmentIndex);
  }

  public getFragment(
    response: Response,
    matchId: string,
    fragmentIndex: number,
  ) {
    const broadcast = this.broadcasts[matchId];
    if (!broadcast) {
      this.logger.error(`Broadcast not found for matchId ${matchId}`);
      this.relayError(
        response,
        404,
        `Broadcast not found for matchId ${matchId}`,
      );
      return;
    }

    const fragment = broadcast.fragments[fragmentIndex];

    if (fragment == null) {
      response.writeHead(404, "Field not found");
      response.end();
      return;
    }
    const headers: { [key: string]: string } = {
      "Content-Type": "application/octet-stream",
    };

    if (fragment.gipped) {
      headers["Content-Encoding"] = "gzip";
    }
    response.writeHead(200, headers);
    response.end(fragment.data);
  }

  public getSyncInfo(
    request: Request,
    response: Response,
    matchId: string,
  ): void {
    const nowMs = Date.now();
    response.setHeader("Cache-Control", "public, max-age=3");
    response.setHeader("Expires", new Date(nowMs + 3000).toUTCString());

    const broadcast = this.broadcasts[matchId];
    if (!broadcast || broadcast.start == null) {
      this.relayError(
        response,
        404,
        `[${matchId}] broadcast not found or not started`,
      );
      return;
    }

    let fragment: Fragment;
    let fragmentIndex: number;
    const fragmentParam = request.query.fragment as string | undefined;

    if (fragmentParam == null) {
      fragment = broadcast.fragments[broadcast.start];
    } else {
      fragmentIndex = parseInt(fragmentParam);

      if (fragmentIndex < broadcast.start) {
        fragmentIndex = broadcast.start;
      }

      for (let i = fragmentIndex; i < broadcast.fragments.length; i++) {
        const _fragment = broadcast.fragments[i];
        if (this.isSyncReady(_fragment)) {
          fragment = _fragment;
          break;
        }
      }
    }

    if (!fragment) {
      console.info(`fragment not found`, fragmentIndex);
      response.writeHead(405, "Fragment not found, please check back soon");
      response.end();
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });

    const startFragment = broadcast.fragments[broadcast.start];

    response.end(
      JSON.stringify({
        tick: fragment.tick,
        endtick: fragment.endtick,
        maxtick: this.getMatchBroadcastEndTick(
          Object.values(broadcast.fragments),
        ),
        rtdelay: (nowMs - fragment.timestamp) / 1000,
        rcvage: (nowMs - startFragment.timestamp) / 1000,
        fragment: fragmentIndex || broadcast.start,
        signup_fragment: broadcast.start,
        tps: startFragment.tps,
        keyframe_interval: startFragment.keyframe_interval,
        map: startFragment.map,
        protocol: startFragment.protocol,
      }),
    );
  }

  public postField(
    request: Request,
    response: Response,
    field: string,
    matchId: string,
    fragmentIndex: number,
  ): void {
    if (!this.broadcasts[matchId]) {
      this.logger.log(`Creating new match broadcast for matchId ${matchId}`);
      this.broadcasts[matchId] = { start: null, fragments: [] };
    }
    const broadcast = this.broadcasts[matchId];

    if (field == "start") {
      if (broadcast.start == null) {
        broadcast.start = fragmentIndex;
      }
    }

    if (broadcast.start == null) {
      response.writeHead(205);
      response.end();
      return;
    }

    response.writeHead(200);

    broadcast.fragments[fragmentIndex] = {
      gipped: false,
    };

    Object.entries(request.query).forEach(([key, value]) => {
      const strValue = String(value);
      const numValue = Number(strValue);
      broadcast.fragments[fragmentIndex][key] =
        !isNaN(numValue) && strValue === String(numValue) ? numValue : value;
    });

    const body: Buffer[] = [];

    request.on("data", function (data: Buffer) {
      body.push(data);
    });

    request.on("end", () => {
      const totalBuffer = Buffer.concat(body);

      broadcast.fragments[fragmentIndex].timestamp = Date.now();

      this.gzip(totalBuffer)
        .then((compressedBlob: Buffer) => {
          broadcast.fragments[fragmentIndex].gipped = true;
          broadcast.fragments[fragmentIndex].data = compressedBlob;

          if (field === "start") {
            broadcast.start = fragmentIndex;
          }
        })
        .catch((error: Error) => {
          this.logger.error(
            `Cannot gzip ${totalBuffer.length} bytes: ${error}`,
          );
          broadcast.fragments[fragmentIndex].data = totalBuffer;
        })
        .finally(() => {
          console.info(`${fragmentIndex}:${field}`);
          response.end();
        });
    });
  }

  private relayError(
    response: Response,
    code: number,
    explanation: string,
  ): void {
    response.writeHead(code, { "X-Reason": explanation });
    response.end();
  }

  private isSyncReady(fragment: any): boolean {
    return (
      fragment != null &&
      typeof fragment === "object" &&
      fragment.full != null &&
      fragment.delta != null &&
      fragment.tick != null &&
      fragment.endtick != null &&
      fragment.timestamp
    );
  }

  private getMatchBroadcastEndTick(fragments: any[]): number {
    for (let i = fragments.length - 1; i >= 0; i--) {
      const fragment = fragments[i];
      if (fragment?.endtick != null) {
        return fragment.endtick;
      }
    }
    return 0;
  }
}
