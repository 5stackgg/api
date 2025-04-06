import { CookieOptions } from "express-serve-static-core";

export function getCookieOptions(
  options: CookieOptions = {},
  defaultOptions: CookieOptions = {
    signed: true,
    /**
     * CSRF Protection :
     *
     * https://web.dev/samesite-cookies-explained/
     *
     * Lax: means that cookies will only be sent for requests on the same origin,
     * including top-level navigation (e.g.: clicking a link to your site or refreshing).
     * Since cookies are sent with top-level navigation, then if the attacker can open a window and
     * there is an endpoint accepting GET requests they can try to abuse it.
     * Lax can be a great solution if you don’t have GET endpoints that they can abuse.
     *
     * Strict:
     *  means that the site’s cookies will only be attached to requests that originated on your site.
     *  This would be great, but it means that users clicking a link to your site will not be logged in,
     *  even if they did so previously. This is, isn’t great UX, so this isn’t a great solution on its own.
     *
     * Lax+Strict:
     *  if you use multiple cookies,
     *  one set to Strict that will be used for sensitive or state-changing operations (e.g.: transferring money, or changing passwords)
     *  and a separate one set to Lax that will enable the users to download non-sensitive data.
     *  This combines the above two for the best effect, but you will need to manage multiple cookies.
     *
     *
     *  Since were using it as headless auth, we are allowed to set to strict, since we dont need top level cookie to be sent
     *  on the initial request
     */
    sameSite: process.env.DEV ? "none" : undefined,
    httpOnly: true,
    domain: process.env.AUTH_COOKIE_DOMAIN || `.${process.env.WEB_DOMAIN}`,
    maxAge: 14 * 24 * 60 * 60 * 1000,
    secure: (process.env.SECURE_COOKIE && process.env.SECURE_COOKIE === "true") || true,
  },
): CookieOptions {
  return Object.assign({}, defaultOptions, options);
}
