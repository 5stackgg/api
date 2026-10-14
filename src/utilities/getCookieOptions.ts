import { CookieOptions } from "express-serve-static-core";

export function getCookieOptions(
  options: CookieOptions = {},
  defaultOptions: CookieOptions = {
    signed: true,
    // Lax keeps the session off cross-site POSTs (CSRF) and still sends it on
    // the top-level GET back from Steam/Discord, which Strict would drop. The
    // panel and api are one site, so their XHRs are unaffected. Dev serves the
    // panel from localhost, which is cross-site to the api.
    sameSite: process.env.DEV ? "none" : "lax",
    httpOnly: true,
    domain: process.env.AUTH_COOKIE_DOMAIN || `.${process.env.WEB_DOMAIN}`,
    maxAge: 14 * 24 * 60 * 60 * 1000,
    secure: process.env.SECURE_COOKIE
      ? process.env.SECURE_COOKIE === "true"
      : true,
  },
): CookieOptions {
  return Object.assign({}, defaultOptions, options);
}
