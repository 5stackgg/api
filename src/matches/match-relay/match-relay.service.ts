import { Injectable } from "@nestjs/common";
import { IncomingMessage, ServerResponse } from "http";
import * as zlib from "zlib";
import * as url from "url";
import { promisify } from "util";

const gzip = promisify(zlib.gzip);

// In-memory storage of all match broadcast fragments, metadata, etc.
const match_broadcasts: { [key: string]: any[] } = {};

// Example of how to support token_redirect (for CDN, unified playcast URL for the whole event, etc.)
let _token_redirect_for_example: string | null = null;

// For backward compatibility, export a getter/setter object
const token_redirect_for_example = {
  get value() {
    return _token_redirect_for_example;
  },
  set value(v: string | null) {
    _token_redirect_for_example = v;
  },
};

const stats = {
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

function respondSimpleError(
  uri: string,
  response: ServerResponse,
  code: number,
  explanation: string,
) {
  response.writeHead(code, { "X-Reason": explanation });
  response.end();
}

function checkFragmentCdnDelayElapsed(fragmentRec: any): boolean {
  if (fragmentRec.cdndelay) {
    if (!fragmentRec.timestamp) {
      console.log("Refusing to serve cdndelay without timestamp");
      return false;
    } else {
      const iusElapsedLiveMilliseconds =
        Date.now().valueOf() -
        (fragmentRec.cdndelay + fragmentRec.timestamp.valueOf());
      if (iusElapsedLiveMilliseconds < 0) {
        console.log(
          "Refusing to serve cdndelay due to " +
            iusElapsedLiveMilliseconds +
            " ms of delay remaining",
        );
        return false;
      }
    }
  }
  return true;
}

function isSyncReady(f: any): boolean {
  return (
    f != null &&
    typeof f === "object" &&
    f.full != null &&
    f.delta != null &&
    f.tick != null &&
    f.endtick != null &&
    f.timestamp &&
    checkFragmentCdnDelayElapsed(f)
  );
}

function getMatchBroadcastEndTick(broadcasted_match: any[]): number {
  for (let f = broadcasted_match.length - 1; f >= 0; f--) {
    if (broadcasted_match[f].endtick) return broadcasted_match[f].endtick;
  }
  return 0;
}

function respondMatchBroadcastSync(
  param: url.UrlWithParsedQuery,
  response: ServerResponse,
  broadcasted_match: any[],
  token_redirect?: string | null,
) {
  const nowMs = Date.now();
  response.setHeader("Cache-Control", "public, max-age=3");
  response.setHeader("Expires", new Date(nowMs + 3000).toUTCString());

  const match_field_0 = broadcasted_match[0];
  if (match_field_0 != null && match_field_0.start != null) {
    let fragment: number | null = null;
    const fragmentParam = param.query.fragment as string | undefined;
    let frag: any = null;

    if (fragmentParam == null) {
      fragment = Math.max(0, broadcasted_match.length - 8);

      if (fragment >= 0 && fragment >= match_field_0.signup_fragment) {
        const f = broadcasted_match[fragment];
        if (isSyncReady(f)) frag = f;
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
        if (isSyncReady(f)) {
          frag = f;
          break;
        }
      }
    }

    if (frag) {
      console.log("Sync fragment " + fragment);
      response.writeHead(200, { "Content-Type": "application/json" });
      if (match_field_0.protocol == null) match_field_0.protocol = 5;

      const jso: any = {
        tick: frag.tick,
        endtick: frag.endtick,
        maxtick: getMatchBroadcastEndTick(broadcasted_match),
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

      if (token_redirect) jso.token_redirect = token_redirect;

      response.end(JSON.stringify(jso));
      return;
    }

    response.writeHead(405, "Fragment not found, please check back soon");
  } else {
    response.writeHead(404, "Broadcast has not started yet");
  }

  response.end();
}

function postField(
  request: IncomingMessage,
  param: url.UrlWithParsedQuery,
  response: ServerResponse,
  broadcasted_match: any[],
  fragment: number,
  field: string,
) {
  if (field == "start") {
    console.log("Start tick " + param.query.tick + " in fragment " + fragment);
    response.writeHead(200);

    if (broadcasted_match[0] == null) broadcasted_match[0] = {};
    if (broadcasted_match[0].signup_fragment > fragment)
      console.log(
        "UNEXPECTED new start fragment " +
          fragment +
          " after " +
          broadcasted_match[0].signup_fragment,
      );

    broadcasted_match[0].signup_fragment = fragment;
    fragment = 0;
  } else {
    if (broadcasted_match[0] == null) {
      console.log("205 - need start fragment");
      response.writeHead(205);
    } else {
      if (broadcasted_match[0].start == null) {
        console.log("205 - need start data");
        response.writeHead(205);
      } else {
        response.writeHead(200);
      }
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
  request.on("end", function () {
    const totalBuffer = Buffer.concat(body);
    if (field == "start")
      console.log(
        "Received [" +
          fragment +
          "]." +
          field +
          ", " +
          totalBuffer.length +
          " bytes in " +
          body.length +
          " pieces",
      );
    response.end();

    const originCdnDelay = request.headers["x-origin-delay"] as string;
    if (originCdnDelay && parseInt(originCdnDelay) > 0) {
      broadcasted_match[fragment].cdndelay = parseInt(originCdnDelay);
    }

    gzip(totalBuffer)
      .then((compressedBlob) => {
        broadcasted_match[fragment][field + "_ungzlen"] = totalBuffer.length;
        broadcasted_match[fragment][field] = compressedBlob;
        broadcasted_match[fragment].timestamp = Date.now();
      })
      .catch((error) => {
        console.log("Cannot gzip " + totalBuffer.length + " bytes: " + error);
        broadcasted_match[fragment][field] = totalBuffer;
        broadcasted_match[fragment].timestamp = Date.now();
      });
  });
}

function serveBlob(
  request: IncomingMessage,
  response: ServerResponse,
  fragmentRec: any,
  field: string,
) {
  let blob = fragmentRec[field];
  const ungzipped_length = fragmentRec[field + "_ungzlen"];

  if (!checkFragmentCdnDelayElapsed(fragmentRec)) {
    blob = null;
  }

  if (blob == null) {
    response.writeHead(404, "Field not found");
    response.end();
  } else {
    if (Buffer.isBuffer(blob)) {
      const headers: { [key: string]: string } = {
        "Content-Type": "application/octet-stream",
      };
      if (ungzipped_length) {
        headers["Content-Encoding"] = "gzip";
      }
      response.writeHead(200, headers);
      response.end(blob);
    } else {
      response.writeHead(404, "Unexpected field type " + typeof blob);
      console.log("Unexpected Field type " + typeof blob);
      response.end();
    }
  }
}

function getStart(
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
    respondSimpleError(
      request.url || "",
      response,
      404,
      "Invalid or expired start fragment, please re-sync",
    );
  } else {
    serveBlob(request, response, broadcasted_match[0], field);
  }
}

function getField(
  request: IncomingMessage,
  response: ServerResponse,
  broadcasted_match: any[],
  fragment: number,
  field: string,
) {
  serveBlob(request, response, broadcasted_match[fragment], field);
}

function getFragmentMetadata(
  response: ServerResponse,
  broadcasted_match: any[],
  fragment: number,
) {
  const res: any = {};
  for (const field in broadcasted_match[fragment]) {
    const f = broadcasted_match[fragment][field];
    if (typeof f == "number") res[field] = f;
    else if (Buffer.isBuffer(f)) res[field] = f.length;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(res));
}

function processRequestUnprotected(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const uri = decodeURI(request.url || "");
  const param = url.parse(uri, true);
  const path = param.pathname?.split("/") || [];
  path.shift();
  (response as any).httpVersion = "1.0";

  const prime = path.shift();

  if (prime == null || prime == "" || prime == "index.html") {
    respondSimpleError(uri, response, 401, "Unauthorized");
    return;
  }

  let isPost: boolean;
  if (request.method == "POST") {
    isPost = true;
  } else if (request.method == "GET") {
    isPost = false;
  } else {
    respondSimpleError(uri, response, 404, "Only POST or GET in this API");
    return;
  }

  let broadcasted_match = match_broadcasts[prime];
  if (broadcasted_match == null) {
    if (isPost) {
      console.log("Creating match_broadcast '" + prime + "'");
      _token_redirect_for_example = prime;
      match_broadcasts[prime] = broadcasted_match = [];
      stats.new_match_broadcasts++;
    } else {
      if (prime == "sync") {
        if (
          _token_redirect_for_example &&
          match_broadcasts[_token_redirect_for_example]
        ) {
          respondMatchBroadcastSync(
            param,
            response,
            match_broadcasts[_token_redirect_for_example],
            _token_redirect_for_example,
          );
          stats.sync++;
        } else {
          respondSimpleError(
            uri,
            response,
            404,
            "match_broadcast " + prime + " not found and no valid token_redirect",
          );
          stats.err[0]++;
        }
      } else {
        respondSimpleError(
          uri,
          response,
          404,
          "match_broadcast " + prime + " not found",
        );
        stats.err[0]++;
      }
      return;
    }
  }

  const requestFragmentOrKey = path.shift();
  if (requestFragmentOrKey == null || requestFragmentOrKey == "") {
    if (isPost) {
      respondSimpleError(uri, response, 405, "Invalid POST: no fragment or field");
      stats.err[1]++;
    } else {
      respondSimpleError(uri, response, 401, "Unauthorized");
    }
    return;
  }

  stats.requests++;

  const fragment = parseInt(requestFragmentOrKey);

  if (String(fragment) != requestFragmentOrKey) {
    if (requestFragmentOrKey == "sync") {
      respondMatchBroadcastSync(param, response, broadcasted_match);
      stats.sync++;
    } else {
      respondSimpleError(
        uri,
        response,
        405,
        "Fragment is not an int or sync",
      );
      stats.err[2]++;
    }
    return;
  }

  const field = path.shift();
  if (isPost) {
    stats.post_field++;
    if (field != null) {
      postField(request, param, response, broadcasted_match, fragment, field);
    } else {
      respondSimpleError(
        uri,
        response,
        405,
        "Cannot post fragment without field name",
      );
      stats.err[3]++;
    }
  } else {
    if (field == "start") {
      getStart(request, response, broadcasted_match, fragment, field);
      stats.get_start++;
    } else if (broadcasted_match[fragment] == null) {
      stats.err[4]++;
      response.writeHead(404, "Fragment " + fragment + " not found");
      response.end();
    } else if (field == null || field == "") {
      getFragmentMetadata(response, broadcasted_match, fragment);
      stats.get_frag_meta++;
    } else {
      getField(request, response, broadcasted_match, fragment, field);
      stats.get_field++;
    }
  }
}

function processRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    processRequestUnprotected(request, response);
  } catch (err: any) {
    console.log(
      new Date().toUTCString() +
        " Exception when processing request " +
        request.url,
    );
    console.log(err);
    console.log(err.stack);
  }
}

@Injectable()
export class MatchRelayService {
  /**
   * Process a playcast request using the reference implementation
   */
  processRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    processRequest(request, response);
  }

  /**
   * Get the match broadcasts storage
   */
  getMatchBroadcasts(): { [key: string]: any[] } {
    return match_broadcasts;
  }

  /**
   * Get the current token redirect value
   */
  getTokenRedirect(): string | null {
    return token_redirect_for_example.value;
  }

  /**
   * Set the token redirect value
   */
  setTokenRedirect(value: string | null): void {
    token_redirect_for_example.value = value;
  }

  /**
   * Get stats
   */
  getStats(): any {
    return stats;
  }
}

