import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import * as express from "express";

@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    express.raw({
      type: "*/*",
      limit: "50mb",
      verify: (req: any, res, buf) => {
        (req as any).rawBody = buf;
        req.body = buf;
      },
    })(req, res, next);
  }
}
