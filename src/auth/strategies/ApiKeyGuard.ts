import { Injectable, CanActivate, ExecutionContext } from "@nestjs/common";
import { ApiKeys } from "../ApiKeys";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeys) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    if (request.user) {
      return true;
    }

    let apiKey = request.headers.authorization || request.headers.Authorization;

    if (!apiKey) {
      return false;
    }

    apiKey = apiKey.replace("Bearer ", "");

    const user = await this.apiKeys.verifyJWT(apiKey);

    if (!user) {
      return false;
    }
    request.user = user;

    return true;
  }
}
