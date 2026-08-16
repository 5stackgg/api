import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { AppConfig } from "../../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { isAllowedOrigin } from "../../utilities/isAllowedOrigin";

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
      const cookieDomain = this.config.get<AppConfig>("app").authCookieDomain;

      if (
        typeof redirect === "string" &&
        SteamGuard.isSafeRedirect(redirect, cookieDomain)
      ) {
        request.session.redirect = redirect;
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

  // Anywhere inside the session cookie's own scope, rather than the one exact
  // web domain. The cookie is set on `.${WEB_DOMAIN}` (see getCookieOptions), so
  // a sibling subdomain is already carrying this session by the time it is
  // redirected to -- refusing to send someone back to the panel they started on
  // does not withhold anything from them. It is what lets a dev tunnel on
  // dev.5stack.gg finish a login rather than landing on production, and it is
  // still a closed list: an arbitrary URL is refused, which is the open-redirect
  // this guards against.
  private static isSafeRedirect(
    redirect: string,
    cookieDomain: string,
  ): boolean {
    if (!redirect) {
      return false;
    }
    if (process.env.DEV) {
      return true;
    }
    if (redirect.startsWith("/") && !redirect.startsWith("//")) {
      return true;
    }
    try {
      return isAllowedOrigin({ origins: [], cookieDomain })(
        new URL(redirect).origin,
      );
    } catch {
      return false;
    }
  }
}
