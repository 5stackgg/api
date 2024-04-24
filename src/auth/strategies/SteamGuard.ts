import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class SteamGuard extends AuthGuard("steam") {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    if (!request.url || (!request.user && request.url.startsWith("auth"))) {
      await super.canActivate(context);
      await super.logIn(request);
    }

    return !!request.user;
  }
}
