import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { AppConfig } from "../../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SteamGuard extends AuthGuard("steam") {
  constructor(private readonly config: ConfigService) {
    super();
  }

  handleRequest(err: any, user: any): any {
    if (err || !user) {
      throw new UnauthorizedException(err || "Invalid login credentials");
    }
    return user;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const request = context.switchToHttp().getRequest();

      const { redirect } = request.query;

      if (redirect) {
        request.session.redirect = redirect as string;
      }

      if (!request.url || (!request.user && request.url.startsWith("/auth"))) {
        const _redirect =
          request.session.redirect ||
          this.config.get<AppConfig>("app").webDomain;

        await super.canActivate(context);
        await super.logIn(request);

        request.session.redirect = _redirect;
        return true;
      }

      return !!request.user;
    } catch (error) {
      console.warn("error", error);
      return false;
    }
  }
}
