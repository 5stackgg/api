import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { HasuraService } from "src/hasura/hasura.service";
import { CacheService } from "src/cache/cache.service";

@Injectable()
export class MatchRelayAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly hasura: HasuraService,
    private readonly logger: Logger,
    private readonly cache: CacheService,
  ) {}

  async use(request: Request, response: Response, next: NextFunction) {
    try {
      const [matchId, apiPassword] = (
        request.headers["x-origin-auth"] as string
      )?.split(":");

      const { matches_by_pk: match } = await this.hasura.query({
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          password: true,
        },
      });

      if (match?.password !== apiPassword) {
        this.logger.warn("invalid api password", {
          matchId,
          apiPassword,
        });
        return response.status(401).end();
      }
    } catch (error) {
      this.logger.warn("unable to fetch server", error.message);
      return response.status(401).end();
    }

    next();
  }
}
