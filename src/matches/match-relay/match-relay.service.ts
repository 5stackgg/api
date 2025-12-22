import zlib from "zlib";
import { promisify } from "util";
import { Request, Response } from "express";
import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class MatchRelayService {
  private readonly gzip = promisify(zlib.gzip);

  private readonly match_broadcasts: { [key: string]: any[] } = {};

  constructor(private readonly logger: Logger) {}

  public getStart(
    response: Response,
    matchId: string,
    fragment: number,
    token?: string,
  ) {
    if (token) {
      this.logger.log(`Token provided for matchId ${matchId}`);
    }

    const broadcasted_match = this.match_broadcasts[matchId];

    if (
      broadcasted_match?.[0] == null ||
      broadcasted_match[0].signup_fragment != fragment
    ) {
      return this.respondSimpleError(
        response,
        404,
        "Invalid or expired start fragment, please re-sync",
      );
    }

    this.serveBlob(response, broadcasted_match[0], "start");
  }

  public getField(
    response: Response,
    matchId: string,
    fragment: number,
    field: string,
    token?: string,
  ) {
    if (token) {
      this.logger.log(`Token provided for matchId ${matchId}`);
    }

    const broadcasted_match = this.match_broadcasts[matchId];
    if (!broadcasted_match) {
      this.logger.error(`Broadcast not found for matchId ${matchId}`);
      this.respondSimpleError(
        response,
        404,
        `Broadcast not found for matchId ${matchId}`,
      );
      return;
    }

    this.serveBlob(response, broadcasted_match[fragment], field);
  }

  public respondMatchBroadcastSync(
    request: Request,
    response: Response,
    matchId: string,
  ): void {
    const nowMs = Date.now();
    response.setHeader("Cache-Control", "public, max-age=3");
    response.setHeader("Expires", new Date(nowMs + 3000).toUTCString());

    const broadcasted_match = this.match_broadcasts[matchId];
    if (!broadcasted_match) {
      this.logger.error(`Broadcast not found for matchId ${matchId}`);
      this.respondSimpleError(
        response,
        404,
        `Broadcast not found for matchId ${matchId}`,
      );
      return;
    }

    const match_field_0 = broadcasted_match[0];
    if (match_field_0 == null || match_field_0.start == null) {
      response.writeHead(404, "Broadcast has not started yet");
      response.end();
      return;
    }

    let fragment: number | null = null;
    const fragmentParam = request.query.fragment as string | undefined;
    let frag: any = null;

    if (fragmentParam == null) {
      fragment = Math.max(0, broadcasted_match.length - 8);

      if (fragment >= 0 && fragment >= match_field_0.signup_fragment) {
        const f = broadcasted_match[fragment];
        if (this.isSyncReady(f)) {
          frag = f;
        }
      }
    } else {
      fragment = parseInt(fragmentParam);

      if (fragment < match_field_0.signup_fragment) {
        fragment = match_field_0.signup_fragment;
      }

      for (; fragment < broadcasted_match.length; fragment++) {
        const f = broadcasted_match[fragment];
        if (this.isSyncReady(f)) {
          frag = f;
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
      maxtick: this.getMatchBroadcastEndTick(broadcasted_match),
      rtdelay: (nowMs - frag.timestamp) / 1000,
      rcvage:
        (nowMs - broadcasted_match[broadcasted_match.length - 1].timestamp) /
        1000,
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
    token?: string,
  ): void {
    if (token) {
      this.logger.log(`Token provided for matchId ${matchId}`);
    }
    if (!this.match_broadcasts[matchId]) {
      this.logger.log(`Creating new match broadcast for matchId ${matchId}`);
      this.match_broadcasts[matchId] = [];
    }
    const broadcasted_match = this.match_broadcasts[matchId];

    if (field == "start") {
      response.writeHead(200);

      if (broadcasted_match[0] == null) {
        broadcasted_match[0] = {};
      }

      broadcasted_match[0].signup_fragment = fragment;
      fragment = 0;
    } else {
      if (broadcasted_match[0] == null) {
        // need start fragment
        response.writeHead(205);
      } else if (broadcasted_match[0].start == null) {
        // need start data
        response.writeHead(205);
      } else {
        response.writeHead(200);
      }
      if (broadcasted_match[fragment] == null) {
        broadcasted_match[fragment] = {};
      }
    }

    // console.log(`query`, request.query);
    for (const q in request.query) {
      const v = request.query[q] as string;
      const n = parseInt(v);
      broadcasted_match[fragment][q] = v == String(n) ? n : v;
    }

    const body: Buffer[] = [];
    request.on("data", function (data: Buffer) {
      body.push(data);
    });
    request.on("end", () => {
      const totalBuffer = Buffer.concat(body);
      response.end();

      this.gzip(totalBuffer)
        .then((compressedBlob: Buffer) => {
          broadcasted_match[fragment][field + "_ungzlen"] = totalBuffer.length;
          broadcasted_match[fragment][field] = compressedBlob;
          broadcasted_match[fragment].timestamp = Date.now();
        })
        .catch((error: Error) => {
          this.logger.error(
            `Cannot gzip ${totalBuffer.length} bytes: ${error}`,
          );
          broadcasted_match[fragment][field] = totalBuffer;
          broadcasted_match[fragment].timestamp = Date.now();
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

  private isSyncReady(f: any): boolean {
    return (
      f != null &&
      typeof f === "object" &&
      f.full != null &&
      f.delta != null &&
      f.tick != null &&
      f.endtick != null &&
      f.timestamp
    );
  }

  private getMatchBroadcastEndTick(broadcasted_match: any[]): number {
    for (let f = broadcasted_match.length - 1; f >= 0; f--) {
      if (broadcasted_match[f].endtick) {
        return broadcasted_match[f].endtick;
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
