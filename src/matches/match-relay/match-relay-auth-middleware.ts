import { CacheService } from "src/cache/cache.service";
import { Request, Response, NextFunction } from "express";
import { HasuraService } from "src/hasura/hasura.service";
import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { timingSafeStringEqual } from "src/utilities/timingSafeStringEqual";

@Injectable()
export class MatchRelayAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly logger: Logger,
    private readonly cache: CacheService,
    private readonly hasura: HasuraService,
  ) {}

  async use(request: Request, response: Response, next: NextFunction) {
    try {
      const originAuth = request.headers["x-origin-auth"];
      if (!originAuth || typeof originAuth !== "string") {
        this.logger.warn(
          `auth: rejecting ${request.method} ${request.url} — missing x-origin-auth`,
        );
        return response.status(401).end();
      }

      const colonIndex = originAuth.indexOf(":");
      if (colonIndex === -1) {
        this.logger.warn(
          `auth: rejecting ${request.method} ${request.url} — x-origin-auth missing colon`,
        );
        return response.status(401).end();
      }

      const matchId = originAuth.substring(0, colonIndex);
      const apiPassword = originAuth.substring(colonIndex + 1);

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

      if (!matchPassword) {
        this.logger.warn(
          `auth: rejecting ${request.method} ${request.url} — no match found for id ${matchId}`,
        );
        return response.status(401).end();
      }

      if (!timingSafeStringEqual(matchPassword, apiPassword)) {
        this.logger.warn(
          `auth: rejecting ${request.method} ${request.url} — password mismatch for match ${matchId}`,
        );
        return response.status(401).end();
      }
    } catch (error) {
      this.logger.warn("unable to fetch server", error.message);
      return response.status(401).end();
    }

    next();
  }
}
