import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { AppConfig } from "../../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";

@Injectable()
export class SteamGuard extends AuthGuard("steam") {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: Logger,
  ) {
    super();
  }

  handleRequest(
    err: any,
    user: any,
    info: any,
    context: ExecutionContext,
  ): any {
    if (err) {
      const request = context.switchToHttp().getRequest();
      const response = context.switchToHttp().getResponse();

      let redirect = request.session.redirect || "/";
      if (redirect.includes("?")) {
        redirect += `&error=${err}`;
      } else {
        redirect += `?error=${err}`;
      }

      response.redirect(redirect);

      throw new UnauthorizedException(err);
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
      this.logger.warn("error", error);
      return false;
    }
  }
}
