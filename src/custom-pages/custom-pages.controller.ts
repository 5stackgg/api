import { Controller, Get, Options, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { User } from "../auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";

@Controller("custom-pages")
export class CustomPagesController {
  @Get("authorize")
  public authorize(@Req() request: Request, @Res() response: Response) {
    // nginx forward-auth runs this for every request to a custom-page backend,
    // including the CORS preflight. Preflight (OPTIONS) requests never carry
    // cookies, so gating them would 401 the preflight and surface as a CORS
    // error before the real credentialed request is sent. Let them through.
    if (
      String(request.headers["x-original-method"]).toUpperCase() === "OPTIONS"
    ) {
      return response.status(200).end();
    }

    const user = request.user as User | undefined;
    if (!user) {
      return response.status(401).end();
    }

    // The plugin ingress may pin a minimum role via this header (auth-snippet /
    // proxy_set_header); absent means any logged-in user is allowed.
    const requiredRole = request.headers["x-5stack-required-role"] as
      | e_player_roles_enum
      | undefined;
    if (requiredRole && !isRoleAbove(user.role, requiredRole)) {
      return response.status(403).end();
    }

    response.setHeader("X-5stack-Steam-Id", user.steam_id);
    response.setHeader("X-5stack-Role", user.role);
    response.setHeader("X-5stack-Name", encodeURIComponent(user.name ?? ""));
    return response.status(200).end();
  }

  @Options("authorize")
  public authorizePreflight(@Res() response: Response) {
    return response.status(200).end();
  }

  // Admin-only: fetch a plugin's 5stack-plugin.json server-side so the settings
  // "Detect" button never hits browser CORS (third-party plugins don't need to
  // allow-list the panel origin). Resolves relative remoteEntry/icon to
  // absolute URLs against the manifest location.
  @Get("detect")
  public async detect(@Req() request: Request, @Res() response: Response) {
    const user = request.user as User | undefined;
    if (!user || !isRoleAbove(user.role, "administrator")) {
      return response.status(403).json({ error: "forbidden" });
    }

    const raw = String(request.query.url ?? "").trim();
    if (!/^https?:\/\//i.test(raw)) {
      return response.status(400).json({ error: "invalid url" });
    }

    const base = raw.replace(/\/+$/, "");
    const manifestUrl = base.endsWith(".json")
      ? base
      : `${base}/5stack-plugin.json`;

    try {
      const res = await fetch(manifestUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return response
          .status(502)
          .json({ error: `manifest responded ${res.status}` });
      }
      const manifest = await res.json();
      const manifestBase = manifestUrl.replace(/\/[^/]*$/, "/");

      const resolveAsset = (v: unknown): string | null => {
        if (typeof v !== "string" || v.length === 0) {
          return null;
        }
        // Inline SVG, absolute URLs, and lucide names are kept as-is; a
        // relative path/filename is resolved against the manifest location.
        if (v.startsWith("<") || /^(https?:|data:)/i.test(v)) {
          return v;
        }
        if (v.includes("/") || /\.(svg|png|jpe?g|webp|gif)$/i.test(v)) {
          return new URL(v, manifestBase).href;
        }
        return v;
      };

      return response.json({
        name: manifest.name ?? manifest.title ?? null,
        slug: manifest.slug ?? null,
        icon: resolveAsset(manifest.icon),
        remoteEntry: manifest.remoteEntry
          ? new URL(manifest.remoteEntry, manifestBase).href
          : null,
        scope: manifest.scope ?? null,
        module: manifest.module ?? manifest.exposedModule ?? null,
        requiredRole: manifest.requiredRole ?? null,
      });
    } catch {
      return response
        .status(502)
        .json({ error: "could not fetch plugin manifest" });
    }
  }
}
