export type GameServersConfig = {
  serverDomain: string;
  serverImage: string;
  namespace: string;
  portRange: [string, string];
  defaultRconPassword: string;
  csUsername: string;
  csPassword: string;
};
