import { json, NextFunction, Request, Response } from "express";
import { NestExpressApplication } from "@nestjs/platform-express";

// Bodies are read before routing and auth run, so every route's limit is one
// an anonymous request can make the api parse. Registered ahead of the general
// parser, which leaves a body alone once it has been read.
const LARGE_JSON_BODIES: Array<{ path: string; limit: string }> = [
  // Whole rows in event payloads, and imports in action inputs. The ingress
  // has no /hasura location, but a path that climbs out of one it does have
  // still arrives here; refuseAmbiguousPaths turns those away first.
  { path: "/hasura", limit: "50mb" },
  // The plugin's recorded smoke: a log capped at 1MiB, ~1.4MB as base64.
  { path: "/utility", limit: "2mb" },
];

const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;
const ENCODED_SEPARATOR = /%2f|%5c/i;

// nginx picks the ingress location (and its body limit) by the normalised path
// but forwards the raw one, which express matches as a case-insensitive prefix
// without resolving dot segments: /hasura/%2e%2e/utility passes nginx as
// /utility and reaches the 50mb /hasura parser here.
function refuseAmbiguousPaths(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const pathname = request.originalUrl.split("?")[0];

  if (
    ENCODED_SEPARATOR.test(pathname) ||
    pathname.split("/").some((segment) => DOT_SEGMENT.test(segment))
  ) {
    response.status(400).json({ message: "Bad Request" });
    return;
  }

  next();
}

export function registerBodyParsers(app: NestExpressApplication) {
  app.use(refuseAmbiguousPaths);

  for (const { path, limit } of LARGE_JSON_BODIES) {
    app.use(path, json({ limit }));
  }

  app.useBodyParser("json", { limit: "1mb" });
  app.useBodyParser("urlencoded", { limit: "1mb", extended: true });
  // WHIP/WHEP offers. Parsing them here rather than draining the stream inside
  // the handler is what makes a request that arrives under some other content
  // type a 400 instead of a socket waiting on an `end` that already fired.
  app.useBodyParser("text", { type: "application/sdp", limit: "256kb" });
}
