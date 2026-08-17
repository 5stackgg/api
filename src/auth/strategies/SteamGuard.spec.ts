import { SteamGuard } from "./SteamGuard";

// Reaching past `private` on purpose: this is the open-redirect guard, and the
// cases below are the reason it exists rather than an implementation detail.
const isSafeRedirect = (
  redirect: string,
  cookieDomain = ".5stack.gg",
  webDomain = "https://5stack.gg",
) =>
  (
    SteamGuard as unknown as {
      isSafeRedirect: (
        redirect: string,
        webDomain: string,
        cookieDomain: string,
      ) => boolean;
    }
  ).isSafeRedirect(redirect, webDomain, cookieDomain);

describe("SteamGuard.isSafeRedirect", () => {
  const dev = process.env.DEV;

  beforeEach(() => {
    delete process.env.DEV;
  });

  afterAll(() => {
    if (dev === undefined) {
      delete process.env.DEV;
    } else {
      process.env.DEV = dev;
    }
  });

  it("allows a relative path", () => {
    expect(isSafeRedirect("/matches/abc/camera")).toBe(true);
  });

  it("refuses a protocol-relative path, which is not local at all", () => {
    expect(isSafeRedirect("//evil.com/x")).toBe(false);
  });

  it("allows the panel's own domain and its subdomains", () => {
    expect(isSafeRedirect("https://5stack.gg/login")).toBe(true);
    expect(isSafeRedirect("https://dev.5stack.gg/login")).toBe(true);
  });

  it("refuses a domain that merely ends with the cookie domain", () => {
    expect(isSafeRedirect("https://evil-5stack.gg/login")).toBe(false);
    expect(isSafeRedirect("https://5stack.gg.evil.com/login")).toBe(false);
  });

  it("refuses an unrelated origin", () => {
    expect(isSafeRedirect("https://evil.com/login")).toBe(false);
  });

  it("allows the panel itself when the cookie domain does not cover it", () => {
    // AUTH_COOKIE_DOMAIN is an override, and one set narrower than the panel's
    // own host used to leave a deployment refusing redirects back to itself.
    expect(
      isSafeRedirect(
        "https://panel.5stack.gg/login",
        ".auth.5stack.gg",
        "https://panel.5stack.gg",
      ),
    ).toBe(true);
    expect(
      isSafeRedirect(
        "https://other.5stack.gg/login",
        ".auth.5stack.gg",
        "https://panel.5stack.gg",
      ),
    ).toBe(false);
  });

  it("refuses a plaintext subdomain", () => {
    expect(isSafeRedirect("http://dev.5stack.gg/login")).toBe(false);
  });

  it("refuses javascript: and other non-http schemes", () => {
    expect(isSafeRedirect("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirect("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
  });

  it("refuses empty and unparseable values", () => {
    expect(isSafeRedirect("")).toBe(false);
    expect(isSafeRedirect("not a url")).toBe(false);
  });

  it("waves everything through in dev, where the panel moves around", () => {
    process.env.DEV = "true";
    expect(isSafeRedirect("http://localhost:3000/login")).toBe(true);
  });
});
