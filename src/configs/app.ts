import { AppConfig } from "./types/AppConfig";

export default (): {
  app: AppConfig;
} => ({
  app: {
    name: process.env.APP_NAME || "5stack",
    appKey: process.env.APP_KEY,
    encSecret: process.env.ENC_SECRET,
    webDomain: process.env.WEB_DOMAIN,
    apiDomain: process.env.API_DOMAIN,
    authCookieDomain: process.env.AUTH_COOKIE_DOMAIN,
  },
});
