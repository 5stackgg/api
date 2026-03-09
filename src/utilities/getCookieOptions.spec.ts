import { getCookieOptions } from "./getCookieOptions";

describe("getCookieOptions", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEV;
    delete process.env.AUTH_COOKIE_DOMAIN;
    delete process.env.WEB_DOMAIN;
    delete process.env.SECURE_COOKIE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns defaults with httpOnly true and 14-day maxAge", () => {
    process.env.WEB_DOMAIN = "example.com";
    const options = getCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.maxAge).toBe(14 * 24 * 60 * 60 * 1000);
    expect(options.signed).toBe(true);
  });

  it("uses AUTH_COOKIE_DOMAIN when set", () => {
    process.env.AUTH_COOKIE_DOMAIN = ".custom.com";
    const options = getCookieOptions();
    expect(options.domain).toBe(".custom.com");
  });

  it("falls back to WEB_DOMAIN with dot prefix", () => {
    process.env.WEB_DOMAIN = "example.com";
    const options = getCookieOptions();
    expect(options.domain).toBe(".example.com");
  });

  it("sets sameSite to none when DEV is set", () => {
    process.env.DEV = "true";
    process.env.WEB_DOMAIN = "localhost";
    const options = getCookieOptions();
    expect(options.sameSite).toBe("none");
  });

  it("sets sameSite to undefined when DEV is not set", () => {
    process.env.WEB_DOMAIN = "example.com";
    const options = getCookieOptions();
    expect(options.sameSite).toBeUndefined();
  });

  it("defaults secure to true when SECURE_COOKIE is not set", () => {
    process.env.WEB_DOMAIN = "example.com";
    const options = getCookieOptions();
    expect(options.secure).toBe(true);
  });

  it("respects SECURE_COOKIE=false", () => {
    process.env.SECURE_COOKIE = "false";
    process.env.WEB_DOMAIN = "example.com";
    const options = getCookieOptions();
    expect(options.secure).toBe(false);
  });

  it("allows overriding defaults with provided options", () => {
    process.env.WEB_DOMAIN = "example.com";
    const options = getCookieOptions({ maxAge: 1000, httpOnly: false });
    expect(options.maxAge).toBe(1000);
    expect(options.httpOnly).toBe(false);
    expect(options.signed).toBe(true);
  });
});
