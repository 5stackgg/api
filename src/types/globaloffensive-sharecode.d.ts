declare module "globaloffensive-sharecode" {
  class ShareCode {
    constructor(code: string);
    decode(): { matchId: string; outcomeId: string; token: string } | false;
  }

  export { ShareCode };
}
