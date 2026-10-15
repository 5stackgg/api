import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";
import { AwardsService } from "./awards.service";

@Injectable()
export class TournamentAwardUploadGuard implements CanActivate {
  constructor(private readonly awards: AwardsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request<{ tournamentId: string }>>();

    if (!request.user) {
      throw new ForbiddenException("Authentication required");
    }

    await this.awards.requireOrganizer(
      request.params.tournamentId,
      request.user,
    );

    return true;
  }
}
