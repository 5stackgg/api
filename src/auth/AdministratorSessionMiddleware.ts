import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { isRoleAbove } from "src/utilities/isRoleAbove";

@Injectable()
export class AdministratorSessionMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction) {
    if (!request.user || !isRoleAbove(request.user.role, "administrator")) {
      response.status(403).json({
        message: "Forbidden",
      });
      return;
    }

    next();
  }
}
