import { CacheService } from "src/cache/cache.service";
import { Request, Response, NextFunction } from "express";
import { HasuraService } from "src/hasura/hasura.service";
import { Injectable, Logger, NestMiddleware } from "@nestjs/common";

@Injectable()
export class MatchRelayAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly logger: Logger,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
  ) {}

  async use(request: Request, response: Response, next: NextFunction) {
    try {
      const [matchId, apiPassword] = (
        request.headers["x-origin-auth"] as string
      )?.split(":");

      const token = request.url.split("/")?.[3];

      const matchPassword = await this.cache.remember(
        `match-relay-auth:${matchId}:${token}`,
        async () => {
          const { matches_by_pk: match } = await this.hasura.query({
            matches_by_pk: {
              __args: {
                id: matchId,
              },
              password: true,
            },
          });

          return match?.password;
        },
        60 * 1000,
      );

      if (matchPassword !== apiPassword) {
        return response.status(401).end();
      }
    } catch (error) {
      this.logger.warn("unable to fetch server", error.message);
      return response.status(401).end();
    }

    next();
  }
}
