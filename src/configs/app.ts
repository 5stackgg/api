import { AppConfig } from "./types/AppConfig";

export default (): {
  app: AppConfig;
} => ({
  app: {
    name: process.env.APP_NAME || "5stack",
    appKey: process.env.APP_KEY,
    encSecret: process.env.ENC_SECRET,
    wsDomain: `wss://${process.env.WS_DOMAIN}`,
    webDomain: `https://${process.env.WEB_DOMAIN}`,
    apiDomain: `https://${process.env.API_DOMAIN}`,
    relayDomain: `https://${process.env.RELAY_DOMAIN}`,
    demosDomain: `https://${process.env.DEMOS_DOMAIN}`,
    gameStreamDomain: `https://${process.env.GAME_STREAM_DOMAIN}`,
    authCookieDomain:
      process.env.AUTH_COOKIE_DOMAIN || `.${process.env.WEB_DOMAIN}`,
    // Full origins, scheme and all -- `https://dev.5stack.gg`, not
    // `dev.5stack.gg` -- because that is the form a browser sends and what the
    // allow list is compared against.
    extraCorsOrigins: (process.env.EXTRA_CORS_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    demoParserUrl: process.env.DEMO_PARSER_URL || "http://demo-parser:8080",
  },
});
