export type AppConfig = {
  name: string;
  appKey: string;
  encSecret: string;
  wsDomain: string;
  webDomain: string;
  apiDomain: string;
  relayDomain: string;
  demosDomain: string;
  gameStreamDomain: string;
  authCookieDomain: string;
  extraCorsOrigins: Array<string>;
  demoParserUrl: string;
};
