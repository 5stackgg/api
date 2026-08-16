import { isAllowedOrigin } from "./isAllowedOrigin";

describe("isAllowedOrigin", () => {
  const allow = isAllowedOrigin({
    origins: [
      "https://5stack.gg",
      "https://api.5stack.gg",
      "http://localhost:3000",
    ],
    cookieDomain: ".5stack.gg",
  });

  it("allows the named origins", () => {
    expect(allow("https://5stack.gg")).toBe(true);
    expect(allow("https://api.5stack.gg")).toBe(true);
  });

  it("allows a plain http origin only when it was named", () => {
    expect(allow("http://localhost:3000")).toBe(true);
    expect(allow("http://localhost:9999")).toBe(false);
  });

  it("allows subdomains sharing the session cookie's scope", () => {
    expect(allow("https://dev.5stack.gg")).toBe(true);
    expect(allow("https://anything.5stack.gg")).toBe(true);
    expect(allow("https://deep.nested.5stack.gg")).toBe(true);
  });

  it("allows the cookie domain itself once the leading dot is stripped", () => {
    expect(allow("https://5stack.gg")).toBe(true);
  });

  // The whole reason the check guards on the dot rather than a bare suffix.
  it("refuses a domain that merely ends with the cookie domain", () => {
    expect(allow("https://evil-5stack.gg")).toBe(false);
    expect(allow("https://5stack.gg.evil.com")).toBe(false);
    expect(allow("https://not5stack.gg")).toBe(false);
  });

  // A Secure cookie is never sent to these, so honouring one would only ever
  // hand a credentialed grant to whoever can answer for the name over http.
  it("refuses a subdomain reached over plaintext", () => {
    expect(allow("http://dev.5stack.gg")).toBe(false);
  });

  it("refuses unrelated origins", () => {
    expect(allow("https://example.com")).toBe(false);
    expect(allow("null")).toBe(false);
    expect(allow("not a url")).toBe(false);
  });

  it("treats a missing Origin as nothing to grant", () => {
    expect(allow(undefined)).toBe(true);
  });

  it("is case insensitive about the host", () => {
    expect(allow("https://DEV.5Stack.GG")).toBe(true);
  });

  it("grants nothing by subdomain when no cookie domain is configured", () => {
    const withoutDomain = isAllowedOrigin({
      origins: ["https://5stack.gg"],
      cookieDomain: "",
    });

    expect(withoutDomain("https://5stack.gg")).toBe(true);
    expect(withoutDomain("https://dev.5stack.gg")).toBe(false);
  });
});
