import { validate } from "uuid";
import { Req, Res, Injectable, NestMiddleware, Logger } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { HasuraService } from "../../hasura/hasura.service";

@Injectable()
export class MatchServerMiddlewareMiddleware implements NestMiddleware {
  constructor(
    private readonly hasura: HasuraService,
    private readonly logger: Logger,
  ) {}

  async use(
    @Req() request: Request,
    @Res() response: Response,
    next: NextFunction,
  ) {
    if (
      this.hasura.checkSecret(request.headers["hasura-admin-secret"] as string)
    ) {
      return next();
    }

    let matchId: string | undefined;
    let serverId: string | undefined;

    matchId = request.body?.matchId || (request.params.matchId as string);
    serverId = request.body?.serverId || (request.params.serverId as string);

    if (!matchId && !serverId) {
      return response.status(401).end();
    }

    const apiPassword = request.headers.authorization
      ?.replace("Bearer", "")
      ?.replace("bearer", "")
      .trim();

    if (serverId) {
      if (!validate(serverId)) {
        return response.status(401).end();
      }
      try {
        const { servers_by_pk: server } = await this.hasura.query({
          servers_by_pk: {
            __args: {
              id: serverId,
            },
            api_password: true,
          },
        });

        if (server?.api_password !== apiPassword) {
          return response.status(401).end();
        }
      } catch (error) {
        this.logger.warn("unable to fetch server", error.message);
        return response.status(401).end();
      }

      return next();
    }

    if (!validate(matchId)) {
      return response.status(401).end();
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        server: {
          api_password: true,
          current_match: {
            id: true,
          },
        },
      },
    });

    if (
      !match?.server?.current_match.id ||
      match?.server.api_password !== apiPassword ||
      match?.server.current_match.id !== matchId
    ) {
      return response.status(401).end();
    }

    next();
  }
}
