import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { ScrimsService } from "./scrims.service";

/**
 * The team's match feed — scrims, league fixtures and tournament matches.
 *
 * Served under `/calendar` rather than `/teams/...` on purpose: the web ingress
 * sends everything on WEB_DOMAIN to Nuxt via a `/(.*)` catch-all, and `/teams`
 * is a real Nuxt page route. Claiming that prefix for the api would swallow the
 * whole team-browsing section of the site. `/calendar` is unclaimed.
 *
 * The route must also be added to the WEB_DOMAIN path whitelist in
 * 5stack-panel/base/api/ingress.yaml, or it resolves to a Nuxt 404.
 */
@Controller("calendar")
export class TeamCalendarController {
  constructor(private readonly scrims: ScrimsService) {}

  // Calendar apps can't send auth headers, so access is gated by a per-team
  // unguessable token (HMAC of the team id) rather than left open to teamId
  // enumeration.
  @Get("team/:teamId.ics")
  async teamCalendar(
    @Param("teamId") teamId: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    if (!this.scrims.validateCalendarToken(teamId, token)) {
      throw new ForbiddenException();
    }
    const ics = await this.scrims.getTeamCalendar(teamId);
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", `inline; filename="matches-${teamId}.ics"`);
    res.send(ics);
  }

  @HasuraAction()
  public async teamCalendarUrl(data: { user: User; team_id: string }) {
    const { user, team_id } = data;

    if (!(await this.scrims.isManager(team_id, user.steam_id))) {
      throw Error("you are not a manager of this team");
    }

    return {
      url: this.scrims.calendarUrl(team_id),
    };
  }
}
