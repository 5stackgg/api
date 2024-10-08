import { AppConfig } from "./types/AppConfig";

export default (): {
  app: AppConfig;
} => ({
  app: {
    name: process.env.APP_NAME || "5stack",
    appKey: process.env.APP_KEY,
    encSecret: process.env.ENC_SECRET,
    webDomain: `https://${process.env.WEB_DOMAIN}`,
    apiDomain: `https://${process.env.API_DOMAIN}`,
    demosDomain: `https://${process.env.DEMOS_DOMAIN}`,
    authCookieDomain: process.env.AUTH_COOKIE_DOMAIN,
  },
});
