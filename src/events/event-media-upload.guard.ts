import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Request } from "express";
import { EventsService } from "./events.service";

@Injectable()
export class EventMediaUploadGuard implements CanActivate {
  constructor(private readonly events: EventsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request<{ eventId: string }>>();

    await this.events.assertCanUpload(request.params.eventId, request.user);

    return true;
  }
}
