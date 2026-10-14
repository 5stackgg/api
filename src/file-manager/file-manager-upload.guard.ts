import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";

// Before the file interceptor, so a signed-in non-admin never gets a file
// buffered. The custom header is the CSRF guard: a cross-site form can post
// multipart with the admin's cookie but cannot set it, and setting it from
// script forces a CORS preflight the api only answers for its own web origin.
// FileManagerService still re-checks the role, since the session's can be stale.
@Injectable()
export class FileManagerUploadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (request.headers["x-requested-with"] !== "XMLHttpRequest") {
      throw new ForbiddenException("Uploads must come from the panel");
    }

    if (request.user?.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }

    return true;
  }
}
