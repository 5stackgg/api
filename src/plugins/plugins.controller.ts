import { Controller, Get, Options, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { User } from "../auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";
import { SystemService } from "src/system/system.service";

// "custom-pages" is the pre-rename path. Deployed plugin ingresses hardcode it
// in their auth-url annotation, so dropping it would break them on upgrade.
@Controller(["plugins", "custom-pages"])
export class PluginsController {
  @Get("authorize")
  public authorize(@Req() request: Request, @Res() response: Response) {
    // nginx forward-auth runs this for every request to a plugin backend,
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

    // nginx discards the body on an auth subrequest, so serving JSON here costs
    // the forward-auth path nothing while letting a plugin backend validate a
    // cookie server-side against this same endpoint.
    return response.status(200).json({
      steam_id: user.steam_id,
      role: user.role,
      name: user.name ?? "",
    });
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

    if (PluginsController.isPrivateHost(raw)) {
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
        deployments: PluginsController.resolveDeployments(
          manifest.deployments,
        ),
      });
    } catch {
      return response
        .status(502)
        .json({ error: "could not fetch plugin manifest" });
    }
  }

  // Deployments the plugin wants watched for image updates. The panel restarts
  // whatever is named here, and the manifest is third-party input, so reserved
  // first-party names are dropped -- otherwise a plugin could declare "api" and
  // get the panel to roll itself. Invalid entries are dropped rather than
  // failing the detect, so one typo doesn't block registering the plugin.
  private static resolveDeployments(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((name): name is string => {
        return (
          typeof name === "string" &&
          name.length <= 63 &&
          /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) &&
          !SystemService.isReservedDeployment(name)
        );
      })
      .slice(0, 8);
  }

  // Best-effort SSRF guard for the admin-only detect fetch: blocks loopback,
  // link-local, private-range IP literals and obvious internal hostnames.
  // Hostnames resolving to private IPs are not caught -- admins are trusted;
  // this only keeps the endpoint from being a casual internal-network probe.
  private static isPrivateHost(rawUrl: string): boolean {
    let hostname: string;
    try {
      hostname = new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return true;
    }

    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return true;
    }

    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19))
      );
    }

    const ipv6 = hostname.replace(/^\[|\]$/g, "");
    if (ipv6.includes(":")) {
      return (
        ipv6 === "::1" ||
        ipv6 === "::" ||
        /^f[cd]/.test(ipv6) ||
        /^fe[89ab]/.test(ipv6) ||
        ipv6.startsWith("::ffff:")
      );
    }

    return false;
  }
}
