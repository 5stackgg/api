import { Req, Res, Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { HasuraService } from "../../hasura/hasura.service";

@Injectable()
export class MatchServerMiddlewareMiddleware implements NestMiddleware {
  constructor(private readonly hasura: HasuraService) {}

  async use(
    @Req() request: Request,
    @Res() response: Response,
    next: NextFunction,
  ) {
    const { matchId, serverId } = request.params;

    if (!matchId && !serverId) {
      return response.status(401).end();
    }

    const apiPassword = request.headers.authorization
      ?.replace("Bearer", "")
      .trim();

    if (serverId) {
      const { servers_by_pk: server } = await this.hasura.query({
        servers_by_pk: [
          {
            id: serverId,
          },
          {
            api_password: true,
          },
        ],
      });

      if (server?.api_password !== apiPassword) {
        return response.status(401).end();
      }
      return next();
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: [
        {
          id: matchId,
        },
        {
          id: true,
          server: {
            api_password: true,
            current_match_id: true,
          },
        },
      ],
    });

    if (
      !match?.server?.current_match_id ||
      match?.server.api_password !== apiPassword ||
      match?.server.current_match_id !== matchId
    ) {
      return response.status(401).end();
    }

    next();
  }
}
