import zlib from "zlib";
import { promisify } from "util";
import { Request, Response } from "express";
import { Injectable, Logger } from "@nestjs/common";
import {
  Fragment,
  StartFieldData,
  FullFieldData,
  DeltaFieldData,
} from "./types/fragment.types";

@Injectable()
export class MatchRelayService {
  private readonly gzip = promisify(zlib.gzip);

  private readonly broadcasts: { [key: string]: Fragment[] } = {};

  constructor(private readonly logger: Logger) {}

  public getStart(response: Response, matchId: string, fragmentIndex: number) {
    const broadcast = this.broadcasts[matchId];

    if (
      broadcast?.[0] == null ||
      broadcast[0].start?.signup_fragment != fragmentIndex
    ) {
      return this.relayError(
        response,
        404,
        "Invalid or expired start fragment, please re-sync",
      );
    }

    this.serveBlob(response, broadcast[0], "start");
  }

  public getFragment(
    response: Response,
    matchId: string,
    fragmentIndex: number,
    field: "start" | "full" | "delta",
  ) {
    const broadcast = this.broadcasts[matchId];
    if (!broadcast) {
      this.relayError(response, 404, `broadcast not found`);
      return;
    }

    const fragment = broadcast[fragmentIndex];
    if (!fragment) {
      response.writeHead(404, "fragment not found");
      response.end();
      return;
    }

    this.serveBlob(response, fragment, field);
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
    if (!broadcast) {
      this.relayError(response, 404, `broadcast not found`);
      return;
    }

    const match_field_0 = broadcast[0];
    // Check if start fragment exists at index 0
    if (match_field_0 == null || match_field_0.start?.data == null) {
      this.relayError(response, 404, `broadcast has not started yet`);
      return;
    }

    let fragmentIndex: number | null = null;
    const fragmentParam = request.query.fragment as string | undefined;
    let fragment: Fragment | null = null;

    if (fragmentParam == null) {
      fragmentIndex = Math.max(0, broadcast.length - 8);

      if (
        fragmentIndex >= 0 &&
        fragmentIndex >= (match_field_0.start.signup_fragment || 0)
      ) {
        const _fragment = broadcast[fragmentIndex];
        if (this.isSyncReady(_fragment)) {
          fragment = _fragment;
        }
      }
    } else {
      fragmentIndex = parseInt(fragmentParam);

      if (fragmentIndex < (match_field_0.start?.signup_fragment || 0)) {
        fragmentIndex = match_field_0.start?.signup_fragment || 0;
      }

      for (let i = fragmentIndex; i < broadcast.length; i++) {
        const _fragment = broadcast[i];
        if (this.isSyncReady(_fragment)) {
          fragment = _fragment;
          fragmentIndex = i;
          break;
        }
      }
    }

    if (!fragment) {
      this.relayError(
        response,
        405,
        `fragment not found, please check back soon`,
      );
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    if (match_field_0.start?.protocol == null) {
      if (!match_field_0.start) {
        match_field_0.start = {};
      }
      match_field_0.start.protocol = 5;
    }

    const fragTick = fragment.full?.tick;
    const fragEndtick = fragment.delta?.endtick;
    const fragTimestamp = fragment.delta?.timestamp;

    response.end(
      JSON.stringify({
        tick: fragTick,
        endtick: fragEndtick,
        maxtick: this.getMatchBroadcastEndTick(broadcast),
        rtdelay: (nowMs - (fragTimestamp || nowMs)) / 1000,
        rcvage:
          (nowMs -
            (broadcast[broadcast.length - 1]?.delta?.timestamp || nowMs)) /
          1000,
        fragment: fragmentIndex,
        signup_fragment: match_field_0.start?.signup_fragment,
        tps: match_field_0.start?.tps,
        keyframe_interval: match_field_0.start?.keyframe_interval,
        map: match_field_0.start?.map,
        protocol: match_field_0.start?.protocol,
      }),
    );
  }

  public postField(
    request: Request,
    response: Response,
    field: "start" | "full" | "delta",
    matchId: string,
    fragmentIndex: number,
  ): void {
    if (!this.broadcasts[matchId]) {
      this.broadcasts[matchId] = [];
    }

    const broadcast = this.broadcasts[matchId];

    if (field == "start") {
      fragmentIndex = 0;
    }

    if (field != "start" && broadcast[0] == null) {
      response.writeHead(205);
      response.end();
      return;
    }

    response.writeHead(200);
    if (broadcast[fragmentIndex] == null) {
      broadcast[fragmentIndex] = {};
    }

    if (broadcast[fragmentIndex][field] == null) {
      broadcast[fragmentIndex][field] = {
        ...(field === "start" ? { signup_fragment: fragmentIndex } : {}),
      };
    }

    Object.entries(request.query).forEach(([key, value]) => {
      broadcast[fragmentIndex][field][key] = value;
    });

    const body: Buffer[] = [];
    request.on("data", function (data: Buffer) {
      body.push(data);
    });

    request.on("end", () => {
      const totalBuffer = Buffer.concat(body);

      response.end();

      if (broadcast[fragmentIndex][field] == null) {
        broadcast[fragmentIndex][field] = {};
      }

      this.gzip(totalBuffer)
        .then((compressedBlob: Buffer) => {
          broadcast[fragmentIndex][field].gipped = true;
          broadcast[fragmentIndex][field].data = compressedBlob;
        })
        .catch((error: Error) => {
          this.logger.error(`cannot gzip: ${error}`);
          broadcast[fragmentIndex][field].gipped = false;
          broadcast[fragmentIndex][field].data = totalBuffer;
        })
        .finally(() => {
          if (field === "delta") {
            broadcast[fragmentIndex][field].timestamp = Date.now();
          }
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

  private isSyncReady(fragment: Fragment | undefined): boolean {
    return (
      fragment != null &&
      fragment.full?.data != null &&
      fragment.delta?.data != null &&
      (fragment.full?.tick != null || fragment.delta?.tick != null) &&
      fragment.delta?.endtick != null &&
      fragment.delta?.timestamp != null
    );
  }

  private getMatchBroadcastEndTick(broadcast: Fragment[]): number {
    for (let i = broadcast.length - 1; i >= 0; i--) {
      const fragment = broadcast[i];
      if (fragment?.delta?.endtick != null) {
        return fragment.delta.endtick;
      }
    }
    return 0;
  }

  private serveBlob(
    response: Response,
    fragmentRec: Fragment | undefined,
    field: string,
  ): void {
    const fieldData = fragmentRec?.[field] as
      | StartFieldData
      | FullFieldData
      | DeltaFieldData
      | undefined;
    const blob = fieldData?.data;

    if (!blob) {
      response.writeHead(404, "Field not found");
      response.end();
      return;
    }

    const headers: { [key: string]: string } = {
      "Content-Type": "application/octet-stream",
    };
    if (fieldData.gipped) {
      headers["Content-Encoding"] = "gzip";
    }
    response.writeHead(200, headers);
    response.end(blob);
  }
}
