import {
  Catch,
  ArgumentsHost,
  HttpException,
  ExceptionFilter,
  Logger,
} from "@nestjs/common";
import { Response } from "express";

@Catch(HttpException)
export class AuthHttpExceptionHandler implements ExceptionFilter {
  constructor(protected readonly logger: Logger) {}

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();

    response.status(status).redirect(`/?error=${exception.message}`);
  }
}
