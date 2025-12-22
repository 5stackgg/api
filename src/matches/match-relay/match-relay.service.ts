import zlib from "zlib";
import { promisify } from "util";
import { Request, Response } from "express";
import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class MatchRelayService {
  private readonly gzip = promisify(zlib.gzip);

  private readonly match_broadcasts: { [key: string]: any[] } = {};

  constructor(private readonly logger: Logger) {}

  public getStart(response: Response, matchId: string, fragment: number) {
    const broadcast = this.match_broadcasts[matchId];

    if (broadcast?.[0] == null || broadcast[0].signup_fragment != fragment) {
      return this.respondSimpleError(
        response,
        404,
        "Invalid or expired start fragment, please re-sync",
      );
    }

    this.serveBlob(response, broadcast[0], "start");
  }

  public getField(
    response: Response,
    matchId: string,
    fragment: number,
    field: string,
  ) {
    const broadcast = this.match_broadcasts[matchId];
    if (!broadcast) {
      this.logger.error(`Broadcast not found for matchId ${matchId}`);
      this.respondSimpleError(
        response,
        404,
        `Broadcast not found for matchId ${matchId}`,
      );
      return;
    }

    this.serveBlob(response, broadcast[fragment], field);
  }

  public respondMatchBroadcastSync(
    request: Request,
    response: Response,
    matchId: string,
  ): void {
    const nowMs = Date.now();
    response.setHeader("Cache-Control", "public, max-age=3");
    response.setHeader("Expires", new Date(nowMs + 3000).toUTCString());

    const broadcast = this.match_broadcasts[matchId];
    if (!broadcast) {
      this.logger.error(`Broadcast not found for matchId ${matchId}`);
      this.respondSimpleError(
        response,
        404,
        `Broadcast not found for matchId ${matchId}`,
      );
      return;
    }

    const match_field_0 = broadcast[0];
    if (match_field_0 == null || match_field_0.start == null) {
      response.writeHead(404, "Broadcast has not started yet");
      response.end();
      return;
    }

    let fragment: number | null = null;
    const fragmentParam = request.query.fragment as string | undefined;
    let frag: any = null;

    if (fragmentParam == null) {
      fragment = Math.max(0, broadcast.length - 8);

      if (fragment >= 0 && fragment >= match_field_0.signup_fragment) {
        const _fragment = broadcast[fragment];
        if (this.isSyncReady(_fragment)) {
          frag = _fragment;
        }
      }
    } else {
      fragment = parseInt(fragmentParam);

      if (fragment < match_field_0.signup_fragment) {
        fragment = match_field_0.signup_fragment;
      }

      for (let i = fragment; i < broadcast.length; i++) {
        const _fragment = broadcast[fragment];
        if (this.isSyncReady(_fragment)) {
          frag = _fragment;
          break;
        }
      }
    }

    if (!frag) {
      response.writeHead(405, "Fragment not found, please check back soon");
      response.end();
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    if (match_field_0.protocol == null) {
      match_field_0.protocol = 5;
    }

    const jso: any = {
      tick: frag.tick,
      endtick: frag.endtick,
      maxtick: this.getMatchBroadcastEndTick(broadcast),
      rtdelay: (nowMs - frag.timestamp) / 1000,
      rcvage: (nowMs - broadcast[broadcast.length - 1].timestamp) / 1000,
      fragment: fragment,
      signup_fragment: match_field_0.signup_fragment,
      tps: match_field_0.tps,
      keyframe_interval: match_field_0.keyframe_interval,
      map: match_field_0.map,
      protocol: match_field_0.protocol,
    };

    response.end(JSON.stringify(jso));
  }

  public postField(
    request: Request,
    response: Response,
    field: string,
    matchId: string,
    fragment: number,
  ): void {
    if (!this.match_broadcasts[matchId]) {
      this.logger.log(`Creating new match broadcast for matchId ${matchId}`);
      this.match_broadcasts[matchId] = [];
    }
    const broadcast = this.match_broadcasts[matchId];

    if (field == "start") {
      response.writeHead(200);

      if (broadcast[0] == null) {
        broadcast[0] = {};
      }

      broadcast[0].signup_fragment = fragment;
      fragment = 0;
    } else {
      if (broadcast[0] == null || broadcast[0].start == null) {
        response.writeHead(205);
      } else {
        response.writeHead(200);
      }
      if (broadcast[fragment] == null) {
        broadcast[fragment] = {};
      }
    }

    Object.entries(request.query).forEach(([key, value]) => {
      const strValue = String(value);
      const numValue = Number(strValue);
      broadcast[fragment][key] =
        !isNaN(numValue) && strValue === String(numValue) ? numValue : value;
    });

    const body: Buffer[] = [];
    request.on("data", function (data: Buffer) {
      body.push(data);
    });
    request.on("end", () => {
      const totalBuffer = Buffer.concat(body);
      response.end();

      this.gzip(totalBuffer)
        .then((compressedBlob: Buffer) => {
          broadcast[fragment][field + "_ungzlen"] = totalBuffer.length;
          broadcast[fragment][field] = compressedBlob;
          broadcast[fragment].timestamp = Date.now();
        })
        .catch((error: Error) => {
          this.logger.error(
            `Cannot gzip ${totalBuffer.length} bytes: ${error}`,
          );
          broadcast[fragment][field] = totalBuffer;
          broadcast[fragment].timestamp = Date.now();
        });
    });
  }

  private respondSimpleError(
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

  private getMatchBroadcastEndTick(broadcast: any[]): number {
    for (let f = broadcast.length - 1; f >= 0; f--) {
      if (broadcast[f].endtick) {
        return broadcast[f].endtick;
      }
    }
    return 0;
  }

  private serveBlob(response: Response, fragmentRec: any, field: string): void {
    const blob = fragmentRec?.[field];

    if (!blob) {
      response.writeHead(404, "Field not found");
      response.end();
      return;
    }

    const ungzipped_length = fragmentRec[field + "_ungzlen"];

    const headers: { [key: string]: string } = {
      "Content-Type": "application/octet-stream",
    };
    if (ungzipped_length) {
      headers["Content-Encoding"] = "gzip";
    }
    response.writeHead(200, headers);
    response.end(blob);
  }
}
