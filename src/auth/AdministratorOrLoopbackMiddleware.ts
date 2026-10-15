import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { isRoleAbove } from "src/utilities/isRoleAbove";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

@Injectable()
export class AdministratorOrLoopbackMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    // kubectl port-forward and exec reach the pod on its own loopback. This
    // reads the socket peer, never req.ip: trust proxy takes that from
    // X-Forwarded-For.
    if (LOOPBACK.has(request.socket.remoteAddress)) {
      next();
      return;
    }

    if (!request.user || !isRoleAbove(request.user.role, "administrator")) {
      response.status(403).json({
        message: "Forbidden",
      });
      return;
    }

    next();
  }
}
