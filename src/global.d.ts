import { User as _User } from "./auth/types/User";

declare global {
  namespace Express {
    interface User extends _User {}

    // tslint:disable-next-line:no-empty-interface
    interface Request {
      isAdmin: boolean;
      user?: User | undefined;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    redirect: string;
  }
}
