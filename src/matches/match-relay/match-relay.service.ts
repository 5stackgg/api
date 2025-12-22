import { Injectable, Logger } from "@nestjs/common";
import { IncomingMessage, ServerResponse } from "http";
import zlib from "zlib";
import url from "url";
import { promisify } from "util";

@Injectable()
export class MatchRelayService {
  private readonly gzip = promisify(zlib.gzip);

  private readonly match_broadcasts: { [key: string]: any[] } = {};

  // Example of how to support token_redirect (for CDN, unified playcast URL for the whole event, etc.)
  private token_redirect: string | null = null;

  private readonly stats = {
    post_field: 0,
    get_field: 0,
    get_start: 0,
    get_frag_meta: 0,
    sync: 0,
    not_found: 0,
    new_match_broadcasts: 0,
    err: [0, 0, 0, 0],
    requests: 0,
    started: Date.now(),
    version: 1,
  };

  constructor(private readonly logger: Logger) {}

  public processRequest(request: IncomingMessage, response: ServerResponse) {
    const uri = decodeURI(request.url || "");
    const param = url.parse(uri, true);
    const path = param.pathname?.split("/") || [];
    path.shift();
    (response as any).httpVersion = "1.0";

    const prime = path.shift();

    console.info("prime", prime);

    if (prime == null || prime == "" || prime == "index.html") {
      this.respondSimpleError(uri, response, 401, "Unauthorized");
      return;
    }

    if (request.method != "POST" && request.method != "GET") {
      this.respondSimpleError(
        uri,
        response,
        404,
        "Only POST or GET in this API",
      );
      return;
    }

    const isPost = request.method == "POST";

    let broadcasted_match = this.match_broadcasts[prime];
    if (broadcasted_match == null) {
      if (isPost) {
        this.logger.log(`Creating match_broadcast '${prime}'`);
        this.token_redirect = prime;
        this.match_broadcasts[prime] = broadcasted_match = [];
        this.stats.new_match_broadcasts++;
      } else {
        if (prime == "sync") {
          console.info({
            uri,
            param,
            path,
          });
          if (
            this.token_redirect &&
            this.match_broadcasts[this.token_redirect]
          ) {
            this.respondMatchBroadcastSync(
              param,
              response,
              this.match_broadcasts[this.token_redirect],
              this.token_redirect,
            );
            this.stats.sync++;
          } else {
            this.respondSimpleError(
              uri,
              response,
              404,
              "match_broadcast " +
                prime +
                " not found and no valid token_redirect",
            );
            this.stats.err[0]++;
          }
        } else {
          this.respondSimpleError(
            uri,
            response,
            404,
            "match_broadcast " + prime + " not found",
          );
          this.stats.err[0]++;
        }
        return;
      }
    }

    const requestFragmentOrKey = path.shift();
    if (requestFragmentOrKey == null || requestFragmentOrKey == "") {
      if (isPost) {
        this.respondSimpleError(
          uri,
          response,
          405,
          "Invalid POST: no fragment or field",
        );
        this.stats.err[1]++;
      } else {
        this.respondSimpleError(uri, response, 401, "Unauthorized");
      }
      return;
    }

    this.stats.requests++;

    const fragment = parseInt(requestFragmentOrKey);

    if (String(fragment) != requestFragmentOrKey) {
      if (requestFragmentOrKey == "sync") {
        this.respondMatchBroadcastSync(param, response, broadcasted_match);
        this.stats.sync++;
      } else {
        this.respondSimpleError(
          uri,
          response,
          405,
          "Fragment is not an int or sync",
        );
        this.stats.err[2]++;
      }
      return;
    }

    const field = path.shift();
    if (isPost) {
      this.stats.post_field++;
      if (field == null) {
        this.respondSimpleError(
          uri,
          response,
          405,
          "Cannot post fragment without field name",
        );
        this.stats.err[3]++;
        return;
      }

      this.postField(
        request,
        param,
        response,
        broadcasted_match,
        fragment,
        field,
      );
      return;
    }

    if (field == "start") {
      this.getStart(request, response, broadcasted_match, fragment, field);
      this.stats.get_start++;
      return;
    }

    if (broadcasted_match[fragment] == null) {
      this.stats.err[4]++;
      response.writeHead(404, "Fragment " + fragment + " not found");
      response.end();
      return;
    }

    if (field == null || field == "") {
      this.getFragmentMetadata(response, broadcasted_match, fragment);
      this.stats.get_frag_meta++;
      return;
    }

    this.getField(request, response, broadcasted_match, fragment, field);
    this.stats.get_field++;
  }

  public getMatchBroadcasts() {
    return this.match_broadcasts;
  }

  public getTokenRedirect() {
    return this.token_redirect;
  }

  public setTokenRedirect(value: string) {
    this.token_redirect = value;
  }

  public getStats() {
    return this.stats;
  }

  private respondSimpleError(
    uri: string,
    response: ServerResponse,
    code: number,
    explanation: string,
  ): void {
    response.writeHead(code, { "X-Reason": explanation });
    response.end();
  }

  private checkFragmentCdnDelayElapsed(fragmentRec: any): boolean {
    if (!fragmentRec.cdndelay) {
      return true;
    }

    if (!fragmentRec.timestamp) {
      this.logger.warn("Refusing to serve cdndelay without timestamp");
      return false;
    }

    const iusElapsedLiveMilliseconds =
      Date.now().valueOf() -
      (fragmentRec.cdndelay + fragmentRec.timestamp.valueOf());
    if (iusElapsedLiveMilliseconds < 0) {
      this.logger.warn(
        `Refusing to serve cdndelay due to ${iusElapsedLiveMilliseconds} ms of delay remaining`,
      );
      return false;
    }

    return true;
  }

  private isSyncReady(f: any): boolean {
    return (
      f != null &&
      typeof f === "object" &&
      f.full != null &&
      f.delta != null &&
      f.tick != null &&
      f.endtick != null &&
      f.timestamp &&
      this.checkFragmentCdnDelayElapsed(f)
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

  private respondMatchBroadcastSync(
    param: url.UrlWithParsedQuery,
    response: ServerResponse,
    broadcasted_match: any[],
    token_redirect?: string | null,
  ): void {
    const nowMs = Date.now();
    response.setHeader("Cache-Control", "public, max-age=3");
    response.setHeader("Expires", new Date(nowMs + 3000).toUTCString());

    const match_field_0 = broadcasted_match[0];
    if (match_field_0 == null || match_field_0.start == null) {
      response.writeHead(404, "Broadcast has not started yet");
      response.end();
      return;
    }

    let fragment: number | null = null;
    const fragmentParam = param.query.fragment as string | undefined;
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
      if (isNaN(fragment)) {
        response.writeHead(405, "Fragment is not an int");
        response.end();
        return;
      }

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

    if (token_redirect) {
      jso.token_redirect = token_redirect;
    }

    response.end(JSON.stringify(jso));
  }

  private postField(
    request: IncomingMessage,
    param: url.UrlWithParsedQuery,
    response: ServerResponse,
    broadcasted_match: any[],
    fragment: number,
    field: string,
  ): void {
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

    for (const q in param.query) {
      const v = param.query[q] as string;
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

      const originCdnDelay = request.headers["x-origin-delay"] as string;
      if (originCdnDelay && parseInt(originCdnDelay) > 0) {
        broadcasted_match[fragment].cdndelay = parseInt(originCdnDelay);
      }

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

  private serveBlob(
    request: IncomingMessage,
    response: ServerResponse,
    fragmentRec: any,
    field: string,
  ): void {
    let blob = fragmentRec[field];
    const ungzipped_length = fragmentRec[field + "_ungzlen"];

    if (!this.checkFragmentCdnDelayElapsed(fragmentRec)) {
      blob = null;
    }

    if (blob == null) {
      response.writeHead(404, "Field not found");
      response.end();
      return;
    }

    if (!Buffer.isBuffer(blob)) {
      response.writeHead(404, "Unexpected field type " + typeof blob);
      this.logger.warn(`Unexpected Field type ${typeof blob}`);
      response.end();
      return;
    }

    const headers: { [key: string]: string } = {
      "Content-Type": "application/octet-stream",
    };
    if (ungzipped_length) {
      headers["Content-Encoding"] = "gzip";
    }
    response.writeHead(200, headers);
    response.end(blob);
  }

  private getStart(
    request: IncomingMessage,
    response: ServerResponse,
    broadcasted_match: any[],
    fragment: number,
    field: string,
  ) {
    if (
      broadcasted_match[0] == null ||
      broadcasted_match[0].signup_fragment != fragment
    ) {
      return this.respondSimpleError(
        request.url || "",
        response,
        404,
        "Invalid or expired start fragment, please re-sync",
      );
    }

    this.serveBlob(request, response, broadcasted_match[0], field);
  }

  private getField(
    request: IncomingMessage,
    response: ServerResponse,
    broadcasted_match: any[],
    fragment: number,
    field: string,
  ) {
    this.serveBlob(request, response, broadcasted_match[fragment], field);
  }

  private getFragmentMetadata(
    response: ServerResponse,
    broadcasted_match: any[],
    fragment: number,
  ) {
    const res: any = {};

    for (const field in broadcasted_match[fragment]) {
      const f = broadcasted_match[fragment][field];
      if (typeof f == "number") {
        res[field] = f;
      } else if (Buffer.isBuffer(f)) {
        res[field] = f.length;
      }
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(res));
  }
}
