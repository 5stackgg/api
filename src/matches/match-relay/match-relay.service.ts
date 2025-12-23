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

  private readonly broadcasts: { [key: string]: Map<number, Fragment> } = {};

  constructor(private readonly logger: Logger) {}

  public removeBroadcast(matchId: string) {
    delete this.broadcasts[matchId];
  }

  public getStart(response: Response, matchId: string, fragmentIndex: number) {
    const broadcast = this.broadcasts[matchId];
    const startFragment = broadcast?.get(0);

    if (
      startFragment == null ||
      startFragment.start?.signup_fragment != fragmentIndex
    ) {
      return this.relayError(
        response,
        404,
        "Invalid or expired start fragment, please re-sync",
      );
    }

    this.serveBlob(response, startFragment, "start");
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

    const fragment = broadcast.get(fragmentIndex);
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

    const startFragment = broadcast.get(0);

    if (startFragment == null || startFragment.start?.data == null) {
      this.relayError(response, 404, `broadcast has not started yet`);
      return;
    }

    let fragmentIndex: number | null = null;
    const fragmentParam = request.query.fragment as string | undefined;
    let fragment: Fragment | null = null;

    const maxIndex =
      broadcast.size > 0 ? Math.max(...Array.from(broadcast.keys())) : 0;

    if (fragmentParam == null) {
      fragmentIndex = Math.max(0, maxIndex - 7);

      if (
        fragmentIndex >= 0 &&
        fragmentIndex >= (startFragment.start.signup_fragment || 0)
      ) {
        const _fragment = broadcast.get(fragmentIndex);
        if (this.isSyncReady(_fragment)) {
          fragment = _fragment;
        }
      }
    } else {
      fragmentIndex = parseInt(fragmentParam);

      if (fragmentIndex < (startFragment.start?.signup_fragment || 0)) {
        fragmentIndex = startFragment.start?.signup_fragment || 0;
      }

      for (let i = fragmentIndex; i <= maxIndex; i++) {
        const _fragment = broadcast.get(i);
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
    if (startFragment.start?.protocol == null) {
      if (!startFragment.start) {
        startFragment.start = {};
      }
      startFragment.start.protocol = 5;
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
            (this.getLastFragment(broadcast)?.delta?.timestamp || nowMs)) /
          1000,
        fragment: fragmentIndex,
        signup_fragment: startFragment.start?.signup_fragment,
        tps: startFragment.start?.tps,
        keyframe_interval: startFragment.start?.keyframe_interval,
        map: startFragment.start?.map,
        protocol: startFragment.start?.protocol,
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
      this.broadcasts[matchId] = new Map();
    }

    const broadcast = this.broadcasts[matchId];

    if (field == "start") {
      fragmentIndex = 0;
    }

    if (field != "start" && !broadcast.has(0)) {
      response.writeHead(205);
      response.end();
      return;
    }

    response.writeHead(200);
    if (!broadcast.has(fragmentIndex)) {
      broadcast.set(fragmentIndex, {});
    }

    const fragment = broadcast.get(fragmentIndex)!;

    if (fragment[field] == null) {
      fragment[field] = {
        ...(field === "start" ? { signup_fragment: fragmentIndex } : {}),
      };
    }

    Object.entries(request.query).forEach(([key, value]) => {
      fragment[field]![key] = value;
    });

    const body: Buffer[] = [];
    request.on("data", function (data: Buffer) {
      body.push(data);
    });

    request.on("end", () => {
      const totalBuffer = Buffer.concat(body);

      if (fragment[field] == null) {
        fragment[field] = {};
      }

      this.gzip(totalBuffer)
        .then((compressedBlob: Buffer) => {
          fragment[field]!.gipped = true;
          fragment[field]!.data = compressedBlob;
        })
        .catch((error: Error) => {
          this.logger.error(`cannot gzip: ${error}`);
          fragment[field]!.gipped = false;
          fragment[field]!.data = totalBuffer;
        })
        .finally(() => {
          response.end();
          fragment[field]!.timestamp = Date.now();
          this.cleanupOldFragments(matchId);
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

  private cleanupOldFragments(matchId: string): void {
    const broadcast = this.broadcasts[matchId];
    if (!broadcast) {
      return;
    }

    const now = Date.now();
    const indicesToDelete: number[] = [];

    for (const [index, fragment] of broadcast.entries()) {
      if (index === 0) {
        continue;
      }
      if (fragment?.delta?.timestamp != null) {
        const timeDiff = now - fragment.delta.timestamp;
        if (timeDiff > 60000) {
          indicesToDelete.push(index);
        }
      }
    }

    for (const index of indicesToDelete) {
      broadcast.delete(index);
    }
  }

  private getMatchBroadcastEndTick(broadcast: Map<number, Fragment>): number {
    const sortedIndices = Array.from(broadcast.keys()).sort((a, b) => b - a);
    for (const index of sortedIndices) {
      const fragment = broadcast.get(index);
      if (fragment?.delta?.endtick != null) {
        return fragment.delta.endtick;
      }
    }
    return 0;
  }

  private getLastFragment(
    broadcast: Map<number, Fragment>,
  ): Fragment | undefined {
    if (broadcast.size === 0) {
      return undefined;
    }
    const maxIndex = Math.max(...Array.from(broadcast.keys()));
    return broadcast.get(maxIndex);
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
