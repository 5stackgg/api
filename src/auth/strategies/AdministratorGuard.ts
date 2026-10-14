import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";

@Injectable()
export class AdministratorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (request.user?.role !== "administrator") {
      throw new ForbiddenException("Administrator access required");
    }

    return true;
  }
}
