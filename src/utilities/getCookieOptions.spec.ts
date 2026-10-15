import express from "express";
import session from "express-session";
import request from "supertest";
import { getCookieOptions } from "./getCookieOptions";

describe("getCookieOptions", () => {
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

  it("keeps the session cookie off cross-site POSTs", () => {
    expect(getCookieOptions().sameSite).toBe("lax");
  });

  it("still sends it cross-site in dev, where the panel runs on localhost", () => {
    process.env.DEV = "true";

    expect(getCookieOptions().sameSite).toBe("none");
  });

  it("is what the login's Set-Cookie carries", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(
      session({
        name: "5stack",
        secret: "test",
        resave: false,
        saveUninitialized: false,
        cookie: getCookieOptions(),
      }),
    );
    app.get("/auth/steam", (req, res) => {
      (req.session as unknown as { redirect: string }).redirect = "/";
      res.end();
    });

    const response = await request(app)
      .get("/auth/steam")
      .set("X-Forwarded-Proto", "https");

    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("5stack=");
    expect(cookie).toContain("SameSite=Lax");
  });
});
