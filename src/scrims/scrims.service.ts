import { createHmac, timingSafeEqual } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MatchAssistantService } from "../matches/match-assistant/match-assistant.service";
import { AppConfig } from "../configs/types/AppConfig";
import { ConfigService } from "@nestjs/config";
import {
  e_notification_types_enum,
  e_player_roles_enum,
  e_scrim_request_statuses_enum,
  match_options_insert_input,
} from "generated/schema";

export type ScrimSettings = {
  team_id: string;
  enabled: boolean;
  regions: Array<string>;
  elo_min?: number | null;
  elo_max?: number | null;
};

export type TeamRanks = {
  avg_elo?: number | null;
  avg_faceit_level?: number | null;
  avg_premier?: number | null;
};

export type AvailabilityWindow = {
  starts_at: string;
  ends_at: string;
  recurring_weekly: boolean;
};

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYTIME_MINUTES = 60;
const WEEK_MINUTES = 7 * 24 * 60;

@Injectable()
export class ScrimsService {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly hasura: HasuraService,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly configService: ConfigService,
    private readonly logger: Logger,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  public static isScrimEnabled(settings?: ScrimSettings | null): boolean {
    return settings?.enabled === true;
  }

  public async isFinderEnabled(): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ value: string }>>(
      `SELECT value FROM settings WHERE name = 'public.scrim_finder_enabled'`,
    );
    return rows.at(0)?.value !== "false";
  }

  public static rangesOverlap(
    a: ScrimSettings | null | undefined,
    b: ScrimSettings | null | undefined,
    ranksA: TeamRanks | null | undefined,
    ranksB: TeamRanks | null | undefined,
  ): boolean {
    const within = (
      value: number | null | undefined,
      min: number | null | undefined,
      max: number | null | undefined,
    ): boolean => {
      if (min == null && max == null) {
        return true;
      }
      if (value == null) {
        return false;
      }
      if (min != null && value < min) {
        return false;
      }
      if (max != null && value > max) {
        return false;
      }
      return true;
    };

    return (
      within(ranksB?.avg_elo, a?.elo_min, a?.elo_max) &&
      within(ranksA?.avg_elo, b?.elo_min, b?.elo_max)
    );
  }

  public static regionsOverlap(
    a: ScrimSettings | null | undefined,
    b: ScrimSettings | null | undefined,
  ): Array<string> {
    const aRegions = a?.regions ?? [];
    const bRegions = b?.regions ?? [];
    if (aRegions.length === 0) {
      return bRegions;
    }
    if (bRegions.length === 0) {
      return aRegions;
    }
    return aRegions.filter((region) => bRegions.includes(region));
  }

  public static matchDurationMinutes(bestOf?: number | null): number {
    return Math.max(1, bestOf ?? 1) * 60;
  }

  private static minuteOfWeek(date: Date): number {
    return (
      date.getUTCDay() * 24 * 60 +
      date.getUTCHours() * 60 +
      date.getUTCMinutes()
    );
  }

  private static freeIntervals(
    windows: Array<AvailabilityWindow>,
  ): Array<[number, number]> {
    const expanded: Array<[number, number]> = [];
    for (const window of windows) {
      if (!window.recurring_weekly) {
        continue;
      }
      let start = ScrimsService.minuteOfWeek(new Date(window.starts_at));
      let end = ScrimsService.minuteOfWeek(new Date(window.ends_at));
      if (end <= start) {
        end += WEEK_MINUTES;
      }
      end += PLAYTIME_MINUTES;
      for (const shift of [-WEEK_MINUTES, 0, WEEK_MINUTES]) {
        expanded.push([start + shift, end + shift]);
      }
    }
    expanded.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of expanded) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    return merged;
  }

  public static windowCovers(
    windows: Array<AvailabilityWindow>,
    startAt: Date,
    durationMinutes: number,
  ): boolean {
    const graceMs = PLAYTIME_MINUTES * 60 * 1000;
    const durationMs = durationMinutes * 60 * 1000;
    for (const window of windows) {
      if (window.recurring_weekly) {
        continue;
      }
      const start = new Date(window.starts_at).getTime();
      const end = new Date(window.ends_at).getTime() + graceMs;
      if (startAt.getTime() >= start && startAt.getTime() + durationMs <= end) {
        return true;
      }
    }

    const reqStart = ScrimsService.minuteOfWeek(startAt);
    const reqEnd = reqStart + durationMinutes;
    return ScrimsService.freeIntervals(windows).some(
      ([start, end]) => reqStart >= start && reqEnd <= end,
    );
  }

  public static windowsOverlap(
    availA: Array<AvailabilityWindow>,
    availB: Array<AvailabilityWindow>,
    startAt: Date,
    durationMinutes: number,
  ): boolean {
    return (
      ScrimsService.windowCovers(availA, startAt, durationMinutes) &&
      ScrimsService.windowCovers(availB, startAt, durationMinutes)
    );
  }

  public async getTeamManagerSteamIds(teamId: string): Promise<Array<string>> {
    const managers = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT t.owner_steam_id::text AS steam_id
         FROM teams t
        WHERE t.id = $1 AND t.owner_steam_id IS NOT NULL
        UNION
       SELECT tr.player_steam_id::text AS steam_id
         FROM team_roster tr
        WHERE tr.team_id = $1 AND tr.role = 'Admin'`,
      [teamId],
    );
    return managers.map(({ steam_id }) => steam_id);
  }

  public async isManager(teamId: string, steamId: string): Promise<boolean> {
    const managers = await this.getTeamManagerSteamIds(teamId);
    return managers.includes(steamId);
  }

  private async getScrimSettings(teamId: string): Promise<ScrimSettings | null> {
    const rows = await this.postgres.query<Array<ScrimSettings>>(
      `SELECT team_id, enabled, regions, elo_min, elo_max
         FROM team_scrim_settings
        WHERE team_id = $1`,
      [teamId],
    );
    return rows.at(0) ?? null;
  }

  private async getTeamRanks(teamId: string): Promise<TeamRanks | null> {
    const rows = await this.postgres.query<Array<TeamRanks>>(
      `SELECT avg_elo, avg_faceit_level, avg_premier
         FROM v_team_ranks
        WHERE team_id = $1`,
      [teamId],
    );
    return rows.at(0) ?? null;
  }

  private async getAvailability(
    teamId: string,
  ): Promise<Array<AvailabilityWindow>> {
    return await this.postgres.query<Array<AvailabilityWindow>>(
      `SELECT starts_at, ends_at, recurring_weekly
         FROM team_scrim_availability
        WHERE team_id = $1`,
      [teamId],
    );
  }

  private async scrimMatchOptionsInput(
    bestOf: number,
  ): Promise<match_options_insert_input> {
    const { map_pools } = await this.hasura.query({
      map_pools: {
        __args: { where: { type: { _eq: "Competitive" } } },
        id: true,
      },
    });

    const map_pool_id = map_pools.at(0)?.id;
    if (!map_pool_id) {
      throw Error("could not create scrim match options");
    }

    return {
      overtime: true,
      knife_round: true,
      mr: 12,
      best_of: bestOf,
      coaches: false,
      map_veto: true,
      map_pool_id,
      type: "Competitive",
    };
  }

  public async hasOpenRequestBetween(
    teamA: string,
    teamB: string,
  ): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM team_scrim_requests
          WHERE status IN ('Pending', 'Countered')
            AND (
              (from_team_id = $1 AND to_team_id = $2)
              OR (from_team_id = $2 AND to_team_id = $1)
            )
       ) AS exists`,
      [teamA, teamB],
    );
    return rows.at(0)?.exists === true;
  }

  private async hasActiveScrimMatch(teamIds: Array<string>): Promise<boolean> {
    const rows = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1
           FROM team_scrim_requests r
           JOIN matches m ON m.id = r.match_id
          WHERE r.status = 'Matched'
            AND (r.from_team_id = ANY($1::uuid[]) OR r.to_team_id = ANY($1::uuid[]))
            AND m.status NOT IN ('Finished', 'Tie', 'Canceled', 'Forfeit', 'Surrendered')
       ) AS exists`,
      [teamIds],
    );
    return rows.at(0)?.exists === true;
  }

  public async createScrimRequest(params: {
    fromTeamId: string;
    toTeamId: string;
    requestedBySteamId: string;
    proposedScheduledAt: Date;
    region?: string | null;
    bestOf?: number;
    autoGenerated: boolean;
  }): Promise<string> {
    const {
      fromTeamId,
      toTeamId,
      requestedBySteamId,
      proposedScheduledAt,
      region,
      bestOf,
      autoGenerated,
    } = params;

    if (fromTeamId === toTeamId) {
      throw Error("a team cannot scrim itself");
    }

    if (!(await this.isFinderEnabled())) {
      throw Error("the scrim finder is disabled");
    }

    if (proposedScheduledAt.getTime() < Date.now()) {
      throw Error("proposed time must be in the future");
    }

    const toSettings = await this.getScrimSettings(toTeamId);
    if (!ScrimsService.isScrimEnabled(toSettings)) {
      throw Error("the requested team is not open for scrims");
    }

    const fromSettings = await this.getScrimSettings(fromTeamId);
    const [fromRanks, toRanks] = await Promise.all([
      this.getTeamRanks(fromTeamId),
      this.getTeamRanks(toTeamId),
    ]);

    if (
      !ScrimsService.rangesOverlap(fromSettings, toSettings, fromRanks, toRanks)
    ) {
      throw Error("team skill ranges do not overlap");
    }

    const [fromAvailability, toAvailability] = await Promise.all([
      this.getAvailability(fromTeamId),
      this.getAvailability(toTeamId),
    ]);

    const durationMinutes = ScrimsService.matchDurationMinutes(bestOf);

    if (autoGenerated) {
      if (
        !ScrimsService.windowsOverlap(
          fromAvailability,
          toAvailability,
          proposedScheduledAt,
          durationMinutes,
        )
      ) {
        throw Error("proposed time is outside both teams' availability");
      }
    } else if (
      !ScrimsService.windowCovers(
        toAvailability,
        proposedScheduledAt,
        durationMinutes,
      )
    ) {
      this.logger.debug(
        `manual scrim request ${fromTeamId}->${toTeamId} proposed ${proposedScheduledAt.toISOString()} did not match server-derived availability (best of ${bestOf ?? 1})`,
      );
    }

    if (await this.hasActiveScrimMatch([fromTeamId, toTeamId])) {
      throw Error("one of the teams already has an active scrim match");
    }

    if (await this.hasOpenRequestBetween(fromTeamId, toTeamId)) {
      throw Error("there is already an open scrim request between these teams");
    }

    const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
    const matchOptions = await this.scrimMatchOptionsInput(bestOf ?? 1);

    let insert_team_scrim_requests_one: { id: string };
    try {
      ({ insert_team_scrim_requests_one } = await this.hasura.mutation({
        insert_team_scrim_requests_one: {
          __args: {
            object: {
              from_team_id: fromTeamId,
              to_team_id: toTeamId,
              awaiting_team_id: toTeamId,
              requested_by_steam_id: requestedBySteamId,
              proposed_scheduled_at: proposedScheduledAt.toISOString(),
              region: region ?? null,
              match_options: { data: matchOptions },
              auto_generated: autoGenerated,
              expires_at: expiresAt.toISOString(),
              status: "Pending",
              proposals: {
                data: [
                  {
                    proposed_by_team_id: fromTeamId,
                    proposed_by_steam_id: requestedBySteamId,
                    proposed_scheduled_at: proposedScheduledAt.toISOString(),
                  },
                ],
              },
            },
          },
          id: true,
        },
      }));
    } catch (error) {
      if (String(error).includes("uq_scrim_req_open")) {
        throw Error("there is already an open scrim request between these teams");
      }
      throw error;
    }

    const requestId = insert_team_scrim_requests_one.id;

    await this.notifyScrim({
      teamId: toTeamId,
      type: "ScrimRequestReceived",
      title: "Scrim Request",
      message: await this.scrimMessage(
        fromTeamId,
        "wants to scrim your team",
        proposedScheduledAt,
      ),
      requestId,
      withResponseActions: true,
    });

    return requestId;
  }

  public async respondToScrimRequest(params: {
    requestId: string;
    steamId: string;
    accept: boolean;
  }): Promise<void> {
    const { requestId, steamId, accept } = params;

    const request = await this.loadRequest(requestId);

    if (!["Pending", "Countered"].includes(request.status)) {
      throw Error("this request can no longer be answered");
    }

    if (!(await this.isManager(request.awaiting_team_id, steamId))) {
      throw Error("you are not allowed to respond to this request");
    }

    if (
      accept &&
      new Date(request.proposed_scheduled_at).getTime() <= Date.now()
    ) {
      throw Error(
        "the proposed time has already passed — counter with a new time",
      );
    }

    await this.clearScrimRequestNotifications(requestId);

    if (!accept) {
      await this.setRequestStatus(requestId, "Declined");
      await this.notifyScrim({
        teamId: request.from_team_id,
        type: "ScrimRequestDeclined",
        title: "Scrim Declined",
        message: await this.scrimMessage(
          request.to_team_id,
          "declined your scrim request",
        ),
        requestId,
      });
      return;
    }

    await this.acceptScrimRequest(request);
  }

  public async counterScrimRequest(params: {
    requestId: string;
    steamId: string;
    proposedScheduledAt: Date;
  }): Promise<void> {
    const { requestId, steamId, proposedScheduledAt } = params;

    const request = await this.loadRequest(requestId);

    if (!["Pending", "Countered"].includes(request.status)) {
      throw Error("this request can no longer be countered");
    }

    if (!(await this.isManager(request.awaiting_team_id, steamId))) {
      throw Error("you are not allowed to counter this request");
    }

    if (proposedScheduledAt.getTime() < Date.now()) {
      throw Error("proposed time must be in the future");
    }

    await this.clearScrimRequestNotifications(requestId);

    const [fromAvailability, toAvailability] = await Promise.all([
      this.getAvailability(request.from_team_id),
      this.getAvailability(request.to_team_id),
    ]);

    if (
      !ScrimsService.windowsOverlap(
        fromAvailability,
        toAvailability,
        proposedScheduledAt,
        ScrimsService.matchDurationMinutes(request.best_of),
      )
    ) {
      this.logger.debug(
        `counter on scrim ${requestId} proposed ${proposedScheduledAt.toISOString()} did not match server-derived availability`,
      );
    }

    const nextAwaiting =
      request.awaiting_team_id === request.from_team_id
        ? request.to_team_id
        : request.from_team_id;

    const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);

    await this.hasura.mutation({
      insert_team_scrim_request_proposals_one: {
        __args: {
          object: {
            request_id: requestId,
            proposed_by_team_id: request.awaiting_team_id,
            proposed_by_steam_id: steamId,
            proposed_scheduled_at: proposedScheduledAt.toISOString(),
          },
        },
        id: true,
      },
      update_team_scrim_requests_by_pk: {
        __args: {
          pk_columns: { id: requestId },
          _set: {
            status: "Countered",
            awaiting_team_id: nextAwaiting,
            proposed_scheduled_at: proposedScheduledAt.toISOString(),
            expires_at: expiresAt.toISOString(),
          },
        },
        id: true,
      },
    });

    await this.notifyScrim({
      teamId: nextAwaiting,
      type: "ScrimRequestCountered",
      title: "Scrim Time Proposed",
      message: await this.scrimMessage(
        request.awaiting_team_id,
        "proposed a new scrim time",
        proposedScheduledAt,
      ),
      requestId,
      withResponseActions: true,
    });
  }

  public async cancelScrimRequest(params: {
    requestId: string;
    steamId: string;
  }): Promise<void> {
    const { requestId, steamId } = params;

    const request = await this.loadRequest(requestId);

    if (["Pending", "Countered"].includes(request.status)) {
      if (!(await this.isManager(request.from_team_id, steamId))) {
        throw Error("you are not allowed to cancel this request");
      }
      await this.clearScrimRequestNotifications(requestId);
      await this.setRequestStatus(requestId, "Cancelled");
      return;
    }

    if (request.status === "Matched") {
      await this.lateCancelScrim(request, steamId);
      return;
    }

    throw Error("this request can no longer be cancelled");
  }

  // The bail is recorded on the request itself (canceled_late /
  // canceled_by_team_id), so it survives the canceled match being GC'd — the
  // match is set Canceled here for UX and removed ~1 day later by
  // RemoveCancelledMatches.
  private async lateCancelScrim(
    request: {
      id: string;
      from_team_id: string;
      to_team_id: string;
      match_id?: string | null;
    },
    steamId: string,
  ): Promise<void> {
    let cancelingTeamId: string | null = null;
    if (await this.isManager(request.from_team_id, steamId)) {
      cancelingTeamId = request.from_team_id;
    } else if (await this.isManager(request.to_team_id, steamId)) {
      cancelingTeamId = request.to_team_id;
    }
    if (!cancelingTeamId) {
      throw Error("you are not allowed to cancel this scrim");
    }

    if (request.match_id) {
      await (this.hasura as any).mutation({
        update_matches_by_pk: {
          __args: {
            pk_columns: { id: request.match_id },
            _set: { status: "Canceled" },
          },
          id: true,
        },
      });
    }

    await (this.hasura as any).mutation({
      update_team_scrim_requests_by_pk: {
        __args: {
          pk_columns: { id: request.id },
          _set: {
            status: "Cancelled",
            canceled_late: true,
            canceled_by_team_id: cancelingTeamId,
            responded_at: new Date().toISOString(),
          },
        },
        id: true,
      },
    });

    const [fromManagers, toManagers] = await Promise.all([
      this.getTeamManagerSteamIds(request.from_team_id),
      this.getTeamManagerSteamIds(request.to_team_id),
    ]);
    const steamIds = Array.from(new Set([...fromManagers, ...toManagers]));
    if (steamIds.length === 0) {
      return;
    }

    await this.notifications.notifyPlayers(
      "ScrimMatchCanceled" as unknown as e_notification_types_enum,
      {
        title: "Scrim Canceled",
        message: "A scheduled scrim was canceled by one of the teams.",
        role: "user" as e_player_roles_enum,
        entity_id: request.id,
        steamIds,
      },
    );
  }

  public async expireStaleRequests(): Promise<number> {
    const expired = await this.postgres.query<
      Array<{ id: string; from_team_id: string; to_team_id: string }>
    >(
      `UPDATE team_scrim_requests
          SET status = 'Expired', responded_at = now()
        WHERE status IN ('Pending', 'Countered')
          AND expires_at < now()
      RETURNING id::text, from_team_id::text, to_team_id::text`,
    );

    for (const request of expired) {
      const [fromManagers, toManagers] = await Promise.all([
        this.getTeamManagerSteamIds(request.from_team_id),
        this.getTeamManagerSteamIds(request.to_team_id),
      ]);
      const steamIds = Array.from(new Set([...fromManagers, ...toManagers]));
      if (steamIds.length === 0) {
        continue;
      }
      await this.notifications.notifyPlayers(
        "ScrimRequestExpired" as unknown as e_notification_types_enum,
        {
          title: "Scrim Request Expired",
          message: "A scrim request expired without a response.",
          role: "user" as e_player_roles_enum,
          entity_id: request.id,
          steamIds,
        },
      );
    }

    return expired.length;
  }

  public async acceptScrimRequest(request: {
    id: string;
    from_team_id: string;
    to_team_id: string;
    proposed_scheduled_at: string;
    region?: string | null;
    match_options_id?: string | null;
    requested_by_steam_id: string;
  }): Promise<void> {
    if (new Date(request.proposed_scheduled_at).getTime() <= Date.now()) {
      throw Error("cannot schedule a scrim in the past");
    }

    if (
      await this.hasActiveScrimMatch([request.from_team_id, request.to_team_id])
    ) {
      throw Error("one of the teams already has an active scrim match");
    }

    const fromSettings = await this.getScrimSettings(request.from_team_id);
    const toSettings = await this.getScrimSettings(request.to_team_id);

    const regions = ScrimsService.regionsOverlap(fromSettings, toSettings);
    const region = request.region ?? regions.at(0) ?? undefined;

    const match = await this.matchAssistant.createTeamVsTeamMatch(
      request.from_team_id,
      request.to_team_id,
      {
        matchOptionsId: request.match_options_id ?? null,
        region,
        organizer_steam_id: request.requested_by_steam_id,
        scheduled_at: request.proposed_scheduled_at,
      },
    );

    await this.hasura.mutation({
      update_team_scrim_requests_by_pk: {
        __args: {
          pk_columns: { id: request.id },
          _set: {
            status: "Matched",
            match_id: match.id,
            responded_at: new Date().toISOString(),
          },
        },
        id: true,
      },
    });

    const scheduledAt = new Date(request.proposed_scheduled_at);

    for (const teamId of [request.from_team_id, request.to_team_id]) {
      const opponentId =
        teamId === request.from_team_id
          ? request.to_team_id
          : request.from_team_id;
      await this.notifyScrim({
        teamId,
        type: "ScrimMatchScheduled",
        title: "Scrim Scheduled",
        message: await this.scrimMessage(
          opponentId,
          "scrim has been scheduled",
          scheduledAt,
        ),
        requestId: request.id,
        withCancelAction: true,
        // Can't be dismissed until the scrim has actually been played.
        deletable: false,
        link: `${this.appConfig.webDomain}/matches/${match.id}`,
      });
    }

    this.logger.log(
      `scheduled scrim match ${match.id} between ${request.from_team_id} and ${request.to_team_id}`,
    );
  }

  private async loadRequest(requestId: string): Promise<{
    id: string;
    from_team_id: string;
    to_team_id: string;
    awaiting_team_id: string;
    status: string;
    proposed_scheduled_at: string;
    region?: string | null;
    match_options_id?: string | null;
    match_id?: string | null;
    best_of?: number | null;
    requested_by_steam_id: string;
  }> {
    const rows = await this.postgres.query<
      Array<{
        id: string;
        from_team_id: string;
        to_team_id: string;
        awaiting_team_id: string;
        status: string;
        proposed_scheduled_at: string;
        region?: string | null;
        match_options_id?: string | null;
        match_id?: string | null;
        best_of?: number | null;
        requested_by_steam_id: string;
      }>
    >(
      `SELECT r.id, r.from_team_id::text, r.to_team_id::text,
              r.awaiting_team_id::text, r.status, r.proposed_scheduled_at,
              r.region, r.match_options_id::text AS match_options_id,
              r.match_id::text AS match_id,
              mo.best_of,
              r.requested_by_steam_id::text
         FROM team_scrim_requests r
         LEFT JOIN match_options mo ON mo.id = r.match_options_id
        WHERE r.id = $1`,
      [requestId],
    );

    const request = rows.at(0);
    if (!request) {
      throw Error("scrim request not found");
    }
    return request;
  }

  private async setRequestStatus(
    requestId: string,
    status: e_scrim_request_statuses_enum,
  ): Promise<void> {
    await this.hasura.mutation({
      update_team_scrim_requests_by_pk: {
        __args: {
          pk_columns: { id: requestId },
          _set: {
            status,
            responded_at: new Date().toISOString(),
          },
        },
        id: true,
      },
    });
  }

  // Once a request is answered/countered/cancelled, its pending-stage
  // notifications (with stale Accept/Decline buttons) are no longer valid —
  // soft-delete them so only the outcome notification remains.
  private async clearScrimRequestNotifications(requestId: string): Promise<void> {
    await (this.hasura as any).mutation({
      update_notifications: {
        __args: {
          where: {
            entity_id: { _eq: requestId },
            type: { _in: ["ScrimRequestReceived", "ScrimRequestCountered"] },
            deleted_at: { _is_null: true },
          },
          _set: { is_read: true, deleted_at: new Date().toISOString() },
        },
        affected_rows: true,
      },
    });
  }

  private async scrimMessage(
    teamId: string,
    action: string,
    proposedAt?: Date,
  ): Promise<string> {
    const { teams_by_pk } = await this.hasura.query({
      teams_by_pk: {
        __args: { id: teamId },
        name: true,
      },
    });

    const safeName = NotificationsService.escapeHtml(
      teams_by_pk?.name ?? "A team",
    );
    const teamUrl = `${this.appConfig.webDomain}/teams/${teamId}`;
    // The notification card shows the proposed time in the viewer's local zone,
    // so the message stays short instead of repeating a raw UTC string.
    void proposedAt;
    return `<a href="${teamUrl}">${safeName}</a> ${action}.`;
  }

  private async notifyScrim(params: {
    teamId: string;
    type:
      | "ScrimRequestReceived"
      | "ScrimRequestCountered"
      | "ScrimRequestAccepted"
      | "ScrimRequestDeclined"
      | "ScrimMatchScheduled";
    title: string;
    message: string;
    requestId: string;
    entityId?: string;
    withResponseActions?: boolean;
    withCancelAction?: boolean;
    deletable?: boolean;
    link?: string;
  }): Promise<void> {
    const steamIds = await this.getTeamManagerSteamIds(params.teamId);
    if (steamIds.length === 0) {
      return;
    }

    let actions:
      | Array<{
          label: string;
          graphql: {
            type: string;
            action: string;
            selection: Record<string, any>;
            variables?: Record<string, any>;
          };
        }>
      | undefined;
    if (params.withResponseActions) {
      actions = [
        {
          label: "Accept",
          graphql: {
            type: "mutation",
            action: "respondToScrimRequest",
            selection: { success: true },
            variables: { request_id: params.requestId, accept: true },
          },
        },
        {
          label: "Decline",
          graphql: {
            type: "mutation",
            action: "respondToScrimRequest",
            selection: { success: true },
            variables: { request_id: params.requestId, accept: false },
          },
        },
      ];
    } else if (params.withCancelAction) {
      actions = [
        {
          label: "Cancel Scrim",
          graphql: {
            type: "mutation",
            action: "cancelScrimRequest",
            selection: { success: true },
            variables: { request_id: params.requestId },
          },
        },
      ];
    }

    await this.notifications.notifyPlayers(
      params.type as e_notification_types_enum,
      {
        title: params.title,
        message: params.message,
        role: "user" as e_player_roles_enum,
        entity_id: params.entityId ?? params.requestId,
        steamIds,
        deletable: params.deletable,
      },
      actions,
    );
  }

  public async runScrimAlerts(): Promise<void> {
    const matches = await this.postgres.query<
      Array<{ alert_id: string; alert_team_id: string }>
    >(
      `SELECT DISTINCT a.id AS alert_id, a.team_id::text AS alert_team_id
         FROM team_scrim_alerts a
         JOIN team_scrim_settings s
           ON s.enabled = true AND s.team_id <> a.team_id
         LEFT JOIN v_team_ranks r ON r.team_id = s.team_id
        WHERE a.enabled = true
          AND (a.last_notified_at IS NULL OR a.last_notified_at < now() - interval '6 hours')
          AND (cardinality(a.regions) = 0 OR a.regions && s.regions)
          AND (a.elo_min IS NULL OR (r.avg_elo IS NOT NULL AND r.avg_elo >= a.elo_min))
          AND (a.elo_max IS NULL OR (r.avg_elo IS NOT NULL AND r.avg_elo <= a.elo_max))`,
    );

    for (const match of matches) {
      const steamIds = await this.getTeamManagerSteamIds(match.alert_team_id);
      if (steamIds.length > 0) {
        await this.notifications.notifyPlayers(
          "ScrimAlertMatch" as e_notification_types_enum,
          {
            title: "Scrim Available",
            message: `A team matching your scrim alert is open for scrims. <a href="${this.appConfig.webDomain}/scrims">Find a scrim</a>.`,
            role: "user" as e_player_roles_enum,
            entity_id: match.alert_id,
            steamIds,
          },
        );
      }

      await this.postgres.query(
        `UPDATE team_scrim_alerts SET last_notified_at = now() WHERE id = $1`,
        [match.alert_id],
      );
    }
  }

  public calendarToken(teamId: string): string {
    return createHmac("sha256", this.appConfig.encSecret)
      .update(`scrim-calendar:${teamId}`)
      .digest("hex");
  }

  public calendarUrl(teamId: string): string {
    return `${this.appConfig.webDomain}/scrims/calendar/${teamId}.ics?token=${this.calendarToken(teamId)}`;
  }

  public validateCalendarToken(teamId: string, token?: string): boolean {
    if (!token) {
      return false;
    }
    const expected = Buffer.from(this.calendarToken(teamId));
    const provided = Buffer.from(token);
    if (expected.length !== provided.length) {
      return false;
    }
    return timingSafeEqual(expected, provided);
  }

  public async getScrimCalendar(teamId: string): Promise<string> {
    const events = await this.postgres.query<
      Array<{
        match_id: string;
        scheduled_at: string;
        from_name: string;
        to_name: string;
      }>
    >(
      `SELECT m.id AS match_id, m.scheduled_at, tf.name AS from_name, tt.name AS to_name
         FROM team_scrim_requests r
         JOIN matches m ON m.id = r.match_id
         JOIN teams tf ON tf.id = r.from_team_id
         JOIN teams tt ON tt.id = r.to_team_id
        WHERE r.status = 'Matched'
          AND m.scheduled_at IS NOT NULL
          AND (r.from_team_id = $1 OR r.to_team_id = $1)`,
      [teamId],
    );

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//5stack//Scrim Finder//EN",
    ];

    for (const event of events) {
      const start = ScrimsService.toICSDate(new Date(event.scheduled_at));
      const summary = ScrimsService.escapeICSText(
        `Scrim ${event.from_name} vs ${event.to_name}`,
      );
      lines.push(
        "BEGIN:VEVENT",
        `UID:scrim-${event.match_id}@5stack`,
        `DTSTART:${start}`,
        `SUMMARY:${summary}`,
        `URL:${this.appConfig.webDomain}/matches/${event.match_id}`,
        "END:VEVENT",
      );
    }

    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }

  private static escapeICSText(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");
  }

  private static toICSDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  }
}
