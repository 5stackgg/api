import { Request } from "express";
import { HasuraService } from "../hasura/hasura.service";
import { MatchAssistantService } from "./match-assistant/match-assistant.service";

export default abstract class MatchAbstractController {
  constructor(
    protected readonly hasura: HasuraService,
    protected readonly matchAssistant: MatchAssistantService
  ) {}

  protected async verifyApiPassword(request: Request, matchId: string) {
    const apiPassword = request.headers.authorization
      ?.replace("Bearer", "")
      .trim();
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
      return false;
    }

    return true;
  }
}
