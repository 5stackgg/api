import { json } from "express";
import { NestExpressApplication } from "@nestjs/platform-express";

// Bodies are read before routing and auth run, so every route's limit is one
// an anonymous request can make the api parse. Registered ahead of the general
// parser, which leaves a body alone once it has been read.
const LARGE_JSON_BODIES: Array<{ path: string; limit: string }> = [
  // Whole rows in event payloads, and imports in action inputs. Only Hasura
  // reaches /hasura: the ingress does not expose it.
  { path: "/hasura", limit: "50mb" },
  // The plugin's recorded smoke: a log capped at 1MiB, ~1.4MB as base64.
  { path: "/utility", limit: "4mb" },
];

export function registerBodyParsers(app: NestExpressApplication) {
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
