import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { AppConfig } from "../../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SteamGuard extends AuthGuard("steam") {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const { redirect } = request.query;

    if (redirect) {
      request.session.redirect = redirect as string;
    }

    if (!request.url || (!request.user && request.url.startsWith("/auth"))) {
      const _redirect =
        request.session.redirect || this.config.get<AppConfig>("app").webDomain;

      await super.canActivate(context);
      await super.logIn(request);

      request.session.redirect = _redirect;
      return true;
    }

    return !!request.user;
  }
}
