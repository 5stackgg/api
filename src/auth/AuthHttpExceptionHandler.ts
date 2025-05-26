import {
  Catch,
  ArgumentsHost,
  HttpException,
  ExceptionFilter,
  Logger,
} from "@nestjs/common";
import { Response } from "express";
import { SteamOpenIdError } from "passport-steam-openid";
import { SteamOpenIdErrorType } from "passport-steam-openid";

@Catch(HttpException)
export class AuthHttpExceptionHandler implements ExceptionFilter {
  constructor(protected readonly logger: Logger) {}

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();

    if (exception instanceof SteamOpenIdError) {
      switch (exception.code) {
        case SteamOpenIdErrorType.InvalidQuery:
          this.logger.warn("invalid query");
          break;
        case SteamOpenIdErrorType.Unauthorized:
          this.logger.warn("unauthorized");
          break;
        case SteamOpenIdErrorType.InvalidSteamId:
          this.logger.warn("invalid Steam ID");
          break;
        case SteamOpenIdErrorType.NonceExpired:
          this.logger.warn("nonce expired");
          break;
        default:
          this.logger.warn("unknown error", exception);
          break;
      }
    }

    response.status(status).redirect(`/?auth-failure=${status}`);
  }
}
