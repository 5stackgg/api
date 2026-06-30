import { Injectable } from "@nestjs/common";
import { Request } from "express";
import { PostgresService } from "src/postgres/postgres.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";

@Injectable()
export class StreamAccessService {
  constructor(private readonly postgres: PostgresService) {}

  public async requireLoginForLiveStreams(): Promise<boolean> {
    const [data] = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM public.settings WHERE name = $1 LIMIT 1`,
      [SystemSettingName.RequireLoginForLiveStreams],
    );

    // Matches the web default (stores/ApplicationSettings.ts): enabled
    // unless an admin has explicitly turned it off.
    return data?.value !== "false";
  }

  // The session cookie (domain .${WEB_DOMAIN}, shared with the stream
  // subdomain) identifies the viewer. When protection is on we require a
  // logged-in user AND block competitors of a LIVE match from watching it —
  // a player/coach seeing the live feed would have an in-game advantage.
  // Once the match is over (a replay), no one is blocked.
  public async authorize(request: Request, matchId?: string): Promise<boolean> {
    if (!(await this.requireLoginForLiveStreams())) {
      return true;
    }

    const user = request.user;
    if (!user) {
      return false;
    }

    const id = matchId ?? this.matchIdFromRequest(request);
    if (id && (await this.isCompetitorInLiveMatch(id, user.steam_id))) {
      return false;
    }

    return true;
  }

  // True when the match is currently Live and the steam_id belongs to a
  // player (either lineup) or a coach of that match.
  private async isCompetitorInLiveMatch(
    matchId: string,
    steamId: string,
  ): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ blocked: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM matches m
         WHERE m.id = $1
           AND m.status = 'Live'
           AND (
             EXISTS (
               SELECT 1 FROM match_lineup_players mlp
               WHERE mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                 AND mlp.steam_id = $2::bigint
             )
             OR EXISTS (
               SELECT 1 FROM match_lineups ml
               WHERE ml.match_id = m.id
                 AND ml.coach_steam_id = $2::bigint
             )
           )
       ) AS blocked`,
      [matchId, steamId],
    );
    return row?.blocked === true;
  }

  // Stream URLs are built as ${gameStreamDomain}/${matchId}/... so the match
  // id is the first path segment. On an nginx forward-auth subrequest the
  // original request line arrives as X-Original-URL.
  private matchIdFromRequest(request: Request): string | null {
    const originalUrl = request.headers["x-original-url"];
    const raw =
      typeof originalUrl === "string" && originalUrl.length > 0
        ? originalUrl
        : request.originalUrl;
    if (!raw) {
      return null;
    }

    let path = raw;
    const schemeIndex = path.indexOf("://");
    if (schemeIndex !== -1) {
      const slash = path.indexOf("/", schemeIndex + 3);
      path = slash === -1 ? "" : path.slice(slash);
    }
    const queryIndex = path.indexOf("?");
    if (queryIndex !== -1) {
      path = path.slice(0, queryIndex);
    }

    const segment = path.split("/").filter(Boolean)[0];
    return segment ? decodeURIComponent(segment) : null;
  }
}
