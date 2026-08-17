// Which browser origins may make a credentialed request to this API.
//
// The named domains, plus anything inside the session cookie's own scope. That
// second part is the whole point: the cookie is set on `.${WEB_DOMAIN}` (see
// getCookieOptions), so the browser already hands a session to every subdomain
// of it whether this list mentions it or not. Refusing those at CORS while the
// cookie goes to them anyway is inconsistent rather than safer, and it is what
// made standing up a dev tunnel on dev.5stack.gg need a redeploy to tell the
// API about an origin it was already issuing sessions to.
//
// Anything outside that domain -- a trycloudflare or ngrok hostname, a
// separately hosted panel -- is not covered and still has to be named in
// EXTRA_CORS_ORIGINS.
export function isAllowedOrigin(options: {
  origins: Array<string>;
  cookieDomain: string;
}) {
  const named = new Set(options.origins);
  const domain = options.cookieDomain.replace(/^\./, "").toLowerCase();

  return (origin?: string) => {
    // No Origin header at all: a server-to-server call, curl, or a same-origin
    // navigation. There is no cross-origin grant to make.
    if (!origin) {
      return true;
    }

    if (named.has(origin)) {
      return true;
    }

    if (!domain) {
      return false;
    }

    let url: URL;

    try {
      url = new URL(origin);
    } catch {
      return false;
    }

    // The cookie is Secure, so a plaintext subdomain could never carry a
    // session in the first place -- and honouring one would hand a credentialed
    // grant to anyone able to answer for a name over http.
    if (url.protocol !== "https:") {
      return false;
    }

    const host = url.hostname.toLowerCase();

    // Guarding on the dot rather than a bare endsWith, or `evil-5stack.gg`
    // would pass as a subdomain of `5stack.gg`.
    return host === domain || host.endsWith(`.${domain}`);
  };
}
