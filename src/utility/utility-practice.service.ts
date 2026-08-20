import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { CacheService } from "../cache/cache.service";
import { MatchAssistantService } from "../matches/match-assistant/match-assistant.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AppConfig } from "../configs/types/AppConfig";
import { SystemSettingName } from "../system/enums/SystemSettingName";
import { isRoleAbove } from "../utilities/isRoleAbove";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "../../generated";
import { User } from "../auth/types/User";
import {
  UtilityPlaybookPayload,
  UtilityPlaybooksService,
} from "./utility-playbooks.service";

export type UtilityPracticeSession = {
  id: string;
  match_id: string | null;
  host_steam_id: string;
  team_id: string | null;
  map_name: string;
  region: string | null;
  collection_id: string | null;
  playbook_id: string | null;
  status: string;
  invite_code: string;
  is_open: boolean;
  last_occupied_at: Date | null;
  empty_since: Date | null;
  expires_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
};

export type StartUtilityPracticeInput = {
  map_name: string;
  region?: string | null;
  collection_id?: string | null;
  team_id?: string | null;
  is_open?: boolean;
  server_id?: string | null;
};

@Injectable()
export class UtilityPracticeService {
  // Competitive is the only sane type: Wingman/Duel boot game_mode 2, which
  // loads the 2v2 layout of the map, and a lineup measured against the wrong
  // geometry is worse than no lineup. get_match_type_min_players('Competitive')
  // is 5, so the substitutes are what buy the other five slots.
  public static readonly MATCH_TYPE = "Competitive";
  public static readonly SUBSTITUTES = 5;
  public static readonly LIVE_STATUSES: ReadonlyArray<string> = [
    "Starting",
    "Ready",
  ];
  private static readonly START_LOCK_SECONDS = 30;
  private static readonly BOOT_GRACE_MINUTES = 10;
  public static readonly CONNECT_MINUTES = 5;
  public static readonly IDLE_MINUTES = 5;
  public static readonly MAX_MINUTES = 60;

  private readonly appConfig: AppConfig;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly hasura: HasuraService,
    private readonly cache: CacheService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly playbooks: UtilityPlaybooksService,
    private readonly notifications: NotificationsService,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
  }

  public static startLockKey(steamId: string): string {
    return `utility-practice:start:${steamId}`;
  }

  public async isEnabled(): Promise<boolean> {
    return (
      (await this.setting(SystemSettingName.UtilityPracticeEnabled)) !== "false"
    );
  }

  public async start(
    user: User,
    input: StartUtilityPracticeInput,
  ): Promise<UtilityPracticeSession> {
    if (!(await this.isEnabled())) {
      throw Error("utility practice is not enabled");
    }

    await this.assertRole(user);

    const lockKey = UtilityPracticeService.startLockKey(user.steam_id);

    if (
      !(await this.cache.acquireLock(
        lockKey,
        UtilityPracticeService.START_LOCK_SECONDS,
      ))
    ) {
      throw Error("you are already starting a practice session");
    }

    try {
      const mapName = await this.resolveMap(input.map_name);

      // A practice server is a pool of its own -- matchmaking never sees
      // type = 'Practice' -- so booking one costs matchmaking nothing and
      // skips both the region search and the headroom reserve.
      const server = input.server_id
        ? await this.practiceServer(input.server_id)
        : await this.freePracticeServer(input.region);

      let region: string;

      try {
        region = server
          ? server.region
          : await this.resolveRegion(input.region);

        if (!server) {
          // Before anything is created, not after: a practice session that takes
          // the last free slot is a scheduled tournament match that cannot boot.
          await this.assertServerHeadroom(region);
        }
      } catch (error) {
        // Turned away for want of a server: that is the queue, and it is what
        // puts a max length on whoever is currently holding one.
        await this.joinWaitlist(
          user.steam_id,
          input.map_name,
          input.region ?? null,
        );
        throw error;
      }

      // Got one -- stop counting against the people still waiting.
      await this.leaveWaitlist(user.steam_id);

      await this.assertDailyLimit(user.steam_id);

      const session = await this.insertSession(user.steam_id, {
        mapName,
        region,
        teamId: input.team_id ?? null,
        collectionId: input.collection_id ?? null,
        isOpen: input.is_open === true,
      });

      try {
        const matchId = await this.createPracticeMatch({
          hostSteamId: user.steam_id,
          mapName,
          region,
          serverId: server?.id ?? null,
        });

        await this.postgres.query(
          "UPDATE public.utility_practice_sessions SET match_id = $2::uuid WHERE id = $1::uuid",
          [session.id, matchId],
        );

        await this.matchAssistant.updateMatchStatus(matchId, "Live");

        return await this.session(session.id);
      } catch (error) {
        await this.fail(session.id, (error as Error)?.message ?? "unknown");
        throw error;
      }
    } finally {
      await this.cache.forget(lockKey);
    }
  }

  // Two things have to happen and the order is the whole point: the lineup row
  // is what makes is_in_lineup true (and therefore what makes
  // get_match_connection_link return a link at all), and the RCON refresh is
  // what makes the practice plugin re-read a roster it has already cached.
  // Return the link before the refresh lands and the player is rejected at
  // connect by a plugin still holding the roster it fetched at boot.
  public async join(
    user: User,
    options: { session_id?: string; invite_code?: string },
  ): Promise<{ session_id: string; match_id: string }> {
    if (options.invite_code) {
      await this.assertInviteLookupRateLimit(user.steam_id);
    }

    const session = await this.findSession(options);

    if (!UtilityPracticeService.LIVE_STATUSES.includes(session.status)) {
      throw Error("that practice session is over");
    }

    if (!session.match_id) {
      throw Error("that practice session has no server yet");
    }

    if (await this.isInLineup(session.match_id, user.steam_id)) {
      return { session_id: session.id, match_id: session.match_id };
    }

    if (!(await this.canJoin(session, user.steam_id))) {
      throw Error("you were not invited to this practice session");
    }

    const lineupId = await this.hostLineupId(session.match_id);

    if (await this.isLineupFull(session.match_id, lineupId)) {
      throw Error("this practice session is full");
    }

    await this.postgres.query(
      `INSERT INTO public.match_lineup_players (match_lineup_id, steam_id)
       VALUES ($1::uuid, $2::bigint)
       ON CONFLICT (match_lineup_id, steam_id) DO NOTHING`,
      [lineupId, user.steam_id],
    );

    await this.matchAssistant.sendUtilityPracticeRefresh(session.match_id);

    await this.touch(session.id);

    return { session_id: session.id, match_id: session.match_id };
  }

  public async leave(
    user: User,
    options: { session_id: string },
  ): Promise<{ success: boolean }> {
    const session = await this.session(options.session_id);

    if (!session) {
      throw Error("practice session not found");
    }

    if (session.host_steam_id === user.steam_id) {
      throw Error("the host leaves by stopping the session");
    }

    if (session.match_id) {
      await this.removeFromLineup(session.match_id, user.steam_id);

      await this.matchAssistant.sendUtilityPracticeRefresh(session.match_id);
    }

    return { success: true };
  }

  public async stop(
    user: User,
    options: { session_id: string },
  ): Promise<{ success: boolean }> {
    const session = await this.session(options.session_id);

    if (!session) {
      throw Error("practice session not found");
    }

    if (
      session.host_steam_id !== user.steam_id &&
      !isRoleAbove(user.role, "administrator")
    ) {
      throw Error("only the host can stop this practice session");
    }

    await this.end(session, "Ended");

    return { success: true };
  }

  public async invite(
    user: User,
    options: { session_id: string; steam_ids: Array<string> },
  ): Promise<{ success: boolean }> {
    const session = await this.session(options.session_id);

    if (!session) {
      throw Error("practice session not found");
    }

    if (session.host_steam_id !== user.steam_id) {
      throw Error("only the host can invite to this practice session");
    }

    if (!UtilityPracticeService.LIVE_STATUSES.includes(session.status)) {
      throw Error("that practice session is over");
    }

    const steamIds = (options.steam_ids ?? [])
      .map((steamId) => String(steamId))
      .filter((steamId) => /^\d{5,20}$/.test(steamId))
      .slice(0, 32);

    if (steamIds.length === 0) {
      throw Error("no players to invite");
    }

    // RETURNING past ON CONFLICT DO NOTHING yields only the rows this call
    // actually wrote, which is exactly who has not been told yet: inviting the
    // same player twice must not buzz them twice.
    const invited = await this.postgres.query<Array<{ steam_id: string }>>(
      `INSERT INTO public.utility_practice_invites
         (utility_practice_session_id, steam_id, invited_by_steam_id)
       SELECT $1::uuid, s.steam_id, $3::bigint
         FROM unnest($2::bigint[]) AS s(steam_id)
        WHERE EXISTS (SELECT 1 FROM public.players p WHERE p.steam_id = s.steam_id)
       ON CONFLICT DO NOTHING
       RETURNING steam_id::text AS steam_id`,
      [session.id, steamIds, user.steam_id],
    );

    await this.notifyInvited(
      session,
      user.steam_id,
      invited.map((row) => row.steam_id),
    );

    return { success: true };
  }

  private async notifyInvited(
    session: UtilityPracticeSession,
    hostSteamId: string,
    steamIds: Array<string>,
  ): Promise<void> {
    if (steamIds.length === 0) {
      return;
    }

    const host = NotificationsService.escapeHtml(
      await this.playerName(hostSteamId),
    );
    const map = NotificationsService.escapeHtml(session.map_name);

    try {
      await this.notifications.notifyPlayers(
        "UtilityPracticeInvite" as e_notification_types_enum,
        {
          title: "Utility Practice Invite",
          message:
            `<b>${host}</b> invited you to practise utility on <b>${map}</b>. ` +
            `<a href="${this.inviteUrl(session)}">Join the session</a>.`,
          role: "user" as e_player_roles_enum,
          entity_id: session.id,
          steamIds,
        },
        [
          {
            label: "Join",
            graphql: {
              type: "mutation",
              action: "joinUtilityPractice",
              selection: { id: true, match_id: true },
              variables: { session_id: session.id },
            },
          },
        ],
      );
    } catch (error) {
      // The invite rows are written and the code still works; failing the
      // action because the bell is unhappy would lose the invite itself.
      this.logger.warn(
        `[utility-practice] unable to notify invitees of ${session.id}: ${(error as Error)?.message}`,
      );
    }
  }

  // Loading an execute changes what everyone on the server is about to be told
  // to do, so it is the host's call, exactly like inviting.
  //
  // The refresh is awaited for the same reason the join path awaits it: the
  // plugin holds what it last fetched, and returning before the RCON lands
  // means the countdown the caller thinks they just armed is still the old one
  // -- or none at all.
  public async loadPlaybook(
    user: User,
    options: { session_id: string; playbook_id?: string | null },
  ): Promise<{ success: boolean }> {
    const session = await this.session(options.session_id);

    if (!session) {
      throw Error("practice session not found");
    }

    if (session.host_steam_id !== user.steam_id) {
      throw Error("only the host can load a playbook");
    }

    if (!UtilityPracticeService.LIVE_STATUSES.includes(session.status)) {
      throw Error("that practice session is over");
    }

    let playbookId: string | null = null;

    if (options.playbook_id) {
      const playbook = await this.playbooks.viewable(user, options.playbook_id);

      if (playbook.map_name !== session.map_name) {
        throw Error("that playbook is for another map");
      }

      playbookId = playbook.id;
    }

    await this.postgres.query(
      "UPDATE public.utility_practice_sessions SET playbook_id = $2::uuid WHERE id = $1::uuid",
      [session.id, playbookId],
    );

    if (session.match_id) {
      await this.matchAssistant.sendUtilityPracticeRefresh(session.match_id);
    }

    return { success: true };
  }

  public async sessionForMatch(
    matchId: string,
  ): Promise<UtilityPracticeSession | null> {
    const [row] = await this.postgres.query<Array<UtilityPracticeSession>>(
      `${UtilityPracticeService.SELECT} WHERE s.match_id = $1::uuid`,
      [matchId],
    );
    return row ?? null;
  }

  // An invite code only resolves while the session is live: the partial unique
  // index that keeps codes unique is scoped to Starting/Ready, so an ended
  // session's code is free to be minted again by somebody else.
  // An invite code is a bearer credential, so the lookup is the enumeration
  // surface rather than the code length alone. Keyed per caller, and the minute
  // is part of the key rather than a refreshed TTL -- re-setting the TTL on
  // every attempt would push the window ahead of a caller who never stops and
  // lock them out for good.
  public static readonly INVITE_LOOKUPS_PER_MINUTE = 10;

  private async assertInviteLookupRateLimit(steamId: string): Promise<void> {
    const key = `utility-invite-lookup:${steamId}:${Math.floor(
      Date.now() / 60000,
    )}`;
    const count = Number(await this.cache.get(key, 0)) + 1;

    await this.cache.put(key, count, 120);

    if (count > UtilityPracticeService.INVITE_LOOKUPS_PER_MINUTE) {
      throw Error("too many invite attempts, try again in a minute");
    }
  }

  private async findSession(options: {
    session_id?: string;
    invite_code?: string;
  }): Promise<UtilityPracticeSession> {
    if (options.session_id) {
      const session = await this.session(options.session_id);

      if (!session) {
        throw Error("practice session not found");
      }

      return session;
    }

    if (!options.invite_code) {
      throw Error("a session id or invite code is required");
    }

    const [row] = await this.postgres.query<Array<UtilityPracticeSession>>(
      `${UtilityPracticeService.SELECT}
        WHERE s.invite_code = $1 AND s.status IN ('Starting', 'Ready')
        LIMIT 1`,
      [String(options.invite_code)],
    );

    if (!row) {
      throw Error("practice session not found");
    }

    return row;
  }

  public async session(sessionId: string): Promise<UtilityPracticeSession | null> {
    const [row] = await this.postgres.query<Array<UtilityPracticeSession>>(
      `${UtilityPracticeService.SELECT} WHERE s.id = $1::uuid`,
      [sessionId],
    );
    return row ?? null;
  }

  // The plugin polls, so this runs on every GET /utility/session. Only the row
  // the UPDATE actually moved out of 'Starting' comes back, which is what keeps
  // "your server is ready" a single buzz rather than one per poll.
  public async markReady(matchId: string): Promise<void> {
    const [session] = await this.postgres.query<
      Array<{ id: string; host_steam_id: string; map_name: string }>
    >(
      `UPDATE public.utility_practice_sessions
          SET status = 'Ready', failure_reason = NULL, last_occupied_at = now()
        WHERE match_id = $1::uuid AND status = 'Starting'
       RETURNING id::text AS id, host_steam_id::text AS host_steam_id, map_name`,
      [matchId],
    );

    if (!session) {
      return;
    }

    await this.notifyReady(matchId, session);
  }

  private async notifyReady(
    matchId: string,
    session: { id: string; host_steam_id: string; map_name: string },
  ): Promise<void> {
    // The host plus anyone already added to the lineup: they were let in while
    // the server was still booting, so the link they were handed only starts
    // working now.
    const players = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT DISTINCT mlp.steam_id::text AS steam_id
         FROM public.match_lineup_players mlp
         INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE ml.match_id = $1::uuid
          AND mlp.steam_id IS NOT NULL`,
      [matchId],
    );

    const steamIds = [
      ...new Set([
        session.host_steam_id,
        ...players.map((player) => player.steam_id),
      ]),
    ];

    const map = NotificationsService.escapeHtml(session.map_name);

    try {
      await this.notifications.notifyPlayers(
        "UtilityPracticeReady" as e_notification_types_enum,
        {
          title: "Practice Server Ready",
          message:
            `Your utility practice server on <b>${map}</b> is up. ` +
            `<a href="${this.mapUrl(session.map_name)}">Open the board</a>.`,
          role: "user" as e_player_roles_enum,
          // Suffixed, not the bare session id: the bell stacks rows that share
          // an entity_id, so an invite and a ready for the same session would
          // collapse into one another and the second would never be seen.
          entity_id: `${session.id}:ready`,
          steamIds,
        },
      );
    } catch (error) {
      this.logger.warn(
        `[utility-practice] unable to announce ${session.id} as ready: ${(error as Error)?.message}`,
      );
    }
  }

  // A practice session has no page of its own -- it is a dialog on the map
  // board -- so the link is the board plus the code that opens the dialog
  // against this session. The web side reads ?practice= as joinInviteCode.
  //
  // The invite code and not the session id: the code is the bearer credential
  // the join flow is built around, and it is what joinUtilityPractice takes on
  // this path.
  private inviteUrl(session: UtilityPracticeSession): string {
    return `${this.mapUrl(session.map_name)}?practice=${encodeURIComponent(
      session.invite_code,
    )}`;
  }

  private mapUrl(mapName: string): string {
    return `${this.appConfig.webDomain}/utility/${encodeURIComponent(mapName)}`;
  }

  private async playerName(steamId: string): Promise<string> {
    const [row] = await this.postgres.query<Array<{ name: string | null }>>(
      "SELECT name FROM public.players WHERE steam_id = $1::bigint",
      [steamId],
    );

    return row?.name ?? "A player";
  }

  public async markFailedForMatch(
    matchId: string,
    reason: string,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_practice_sessions
          SET status = 'Failed', failure_reason = $2
        WHERE match_id = $1::uuid AND status IN ('Starting', 'Ready')`,
      [matchId, reason.slice(0, 500)],
    );
  }

  public async markEndedForMatch(matchId: string): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_practice_sessions
          SET status = 'Ended'
        WHERE match_id = $1::uuid AND status IN ('Starting', 'Ready')`,
      [matchId],
    );
  }

  public async touch(sessionId: string): Promise<void> {
    await this.postgres.query(
      "UPDATE public.utility_practice_sessions SET last_occupied_at = now() WHERE id = $1::uuid",
      [sessionId],
    );
  }

  // The practice server itself asks who may connect, so the session is always
  // resolved from the authenticated server -- never from an id the caller
  // supplies. A compromised game server that could name a session id could read
  // another session's match password and walk straight onto that server.
  public async sessionForServer(serverId: string): Promise<{
    session_id: string;
    match_id: string;
    map_name: string;
    password: string;
    steam_ids: Array<string>;
    playbook: UtilityPlaybookPayload | null;
  } | null> {
    const row = await this.liveSessionForServer(serverId);

    if (!row) {
      return null;
    }

    const players = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT mlp.steam_id::text AS steam_id
         FROM public.match_lineup_players mlp
         INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE ml.match_id = $1::uuid
          AND mlp.steam_id IS NOT NULL`,
      [row.match_id],
    );

    return {
      ...row,
      steam_ids: players.map((player) => player.steam_id),
      playbook: await this.playbooks.forSession(row.session_id),
    };
  }

  // The bare row behind sessionForServer, for callers that only need to know
  // which session the authenticated server is running -- scoring a throw asks
  // once per grenade and has no use for the roster or the loaded execute.
  public async liveSessionForServer(serverId: string): Promise<{
    session_id: string;
    match_id: string;
    map_name: string;
    password: string;
  } | null> {
    const [row] = await this.postgres.query<
      Array<{
        session_id: string;
        match_id: string;
        map_name: string;
        password: string;
      }>
    >(
      `SELECT s.id::text AS session_id,
              m.id::text AS match_id,
              s.map_name,
              m.password
         FROM public.servers srv
         INNER JOIN public.matches m ON m.id = srv.reserved_by_match_id
         INNER JOIN public.utility_practice_sessions s ON s.match_id = m.id
        WHERE srv.id = $1::uuid
          AND s.status IN ('Starting', 'Ready')`,
      [serverId],
    );

    return row ?? null;
  }

  public async reapIdle(): Promise<number> {
    const idle = await this.minutes(
      SystemSettingName.UtilityPracticeIdleMinutes,
      UtilityPracticeService.IDLE_MINUTES,
    );
    const connect = await this.minutes(
      SystemSettingName.UtilityPracticeConnectMinutes,
      UtilityPracticeService.CONNECT_MINUTES,
    );
    const max = await this.minutes(
      SystemSettingName.UtilityPracticeMaxMinutes,
      UtilityPracticeService.MAX_MINUTES,
    );
    const contended = await this.anyoneWaiting();

    const sessions = await this.postgres.query<Array<UtilityPracticeSession>>(
      `${UtilityPracticeService.SELECT} WHERE s.status IN ('Starting', 'Ready')`,
    );

    let reaped = 0;

    for (const session of sessions) {
      try {
        // A session that never reached Ready has nobody to be idle: it is
        // waiting on a boot, and the only honest outcome after the grace is
        // Failed. Reaping it on the idle timer instead would call a server that
        // never existed "empty".
        if (
          session.status === "Starting" &&
          UtilityPracticeService.olderThanMinutes(
            session.created_at,
            UtilityPracticeService.BOOT_GRACE_MINUTES,
          )
        ) {
          await this.end(session, "Failed");
          reaped++;
          continue;
        }

        if (!session.match_id) {
          continue;
        }

        // GET /utility/session is the definitive Ready signal -- the plugin is up
        // and asking who may connect. This is the backstop for a server that
        // came up before anyone asked.
        if (
          session.status === "Starting" &&
          (await this.serverIsConnected(session.match_id))
        ) {
          await this.markReady(session.match_id);
        }

        // A max length is only fair while somebody is queuing for the server;
        // an uncontended session runs as long as its host wants it.
        if (
          contended &&
          UtilityPracticeService.olderThanMinutes(session.created_at, max)
        ) {
          await this.end(await this.session(session.id), "Ended");
          reaped++;
          continue;
        }

        const occupied = await this.connectedPlayers(session.match_id);

        if (occupied > 0) {
          await this.postgres.query(
            `UPDATE public.utility_practice_sessions
                SET first_joined_at = COALESCE(first_joined_at, now())
              WHERE id = $1::uuid`,
            [session.id],
          );
          await this.touch(session.id);
          continue;
        }

        // Nobody has ever connected: this is the connect grace, not idleness.
        // Booking a server and walking away is the cheapest way to hold one
        // hostage, so it gets the shorter clock.
        const [joined] = await this.postgres.query<
          Array<{ ever: boolean }>
        >(
          "SELECT first_joined_at IS NOT NULL AS ever FROM public.utility_practice_sessions WHERE id = $1::uuid",
          [session.id],
        );

        if (!joined?.ever) {
          if (
            UtilityPracticeService.olderThanMinutes(session.created_at, connect)
          ) {
            await this.end(await this.session(session.id), "Ended");
            reaped++;
          }
          continue;
        }

        await this.postgres.query(
          `UPDATE public.utility_practice_sessions
              SET empty_since = COALESCE(empty_since, now())
            WHERE id = $1::uuid`,
          [session.id],
        );

        const [row] = await this.postgres.query<Array<{ stale: boolean }>>(
          `SELECT empty_since IS NOT NULL
                  AND empty_since < now() - ($2 || ' minutes')::interval AS stale
             FROM public.utility_practice_sessions WHERE id = $1::uuid`,
          [session.id, String(idle)],
        );

        if (row?.stale) {
          await this.end(await this.session(session.id), "Ended");
          reaped++;
        }
      } catch (error) {
        this.logger.warn(
          `[utility-practice ${session.id}] reaper failed: ${(error as Error)?.message}`,
        );
      }
    }

    if (reaped > 0) {
      this.logger.log(`reaped ${reaped} idle utility practice session(s)`);
    }

    return reaped;
  }

  private static readonly SELECT = `
    SELECT s.id::text AS id,
           s.match_id::text AS match_id,
           s.host_steam_id::text AS host_steam_id,
           s.team_id::text AS team_id,
           s.map_name,
           s.region,
           s.collection_id::text AS collection_id,
           s.playbook_id::text AS playbook_id,
           s.status,
           s.invite_code,
           s.is_open,
           s.last_occupied_at,
           s.empty_since,
           s.expires_at,
           s.failure_reason,
           s.created_at
      FROM public.utility_practice_sessions s`;

  private static olderThanMinutes(
    value: Date | null,
    minutes: number,
  ): boolean {
    if (!value) {
      return false;
    }
    return Date.now() - new Date(value).getTime() > minutes * 60 * 1000;
  }

  private async end(
    session: UtilityPracticeSession | null,
    status: "Ended" | "Failed",
  ): Promise<void> {
    if (!session) {
      return;
    }

    await this.postgres.query(
      "UPDATE public.utility_practice_sessions SET status = $2 WHERE id = $1::uuid",
      [session.id, status],
    );

    if (!session.match_id) {
      // No match means nothing to cancel -- and nothing to release the server
      // this session may already have claimed. Sweep it here rather than wait
      // for the reaper.
      await this.releaseOrphanedServers();
      return;
    }

    // Cancels the match, which re-fires match_events and takes the practice
    // branch: that is what enqueues StopOnDemandServer and releases the server.
    await this.matchAssistant.updateMatchStatus(session.match_id, "Canceled");
  }

  private async fail(sessionId: string, reason: string): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_practice_sessions
          SET status = 'Failed', failure_reason = $2
        WHERE id = $1::uuid`,
      [sessionId, reason.slice(0, 500)],
    );
  }

  private async insertSession(
    hostSteamId: string,
    options: {
      mapName: string;
      region: string;
      teamId: string | null;
      collectionId: string | null;
      isOpen: boolean;
    },
  ): Promise<UtilityPracticeSession> {
    // generate_utility_invite_code() is 50 bits, so a collision is vanishingly
    // rare -- but the uniqueness index only covers live sessions, so it is not
    // impossible, and it must read as "try again", not as a failed start.
    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await this.postgres.query<Array<{ id: string }>>(
          `INSERT INTO public.utility_practice_sessions
             (host_steam_id, map_name, region, team_id, collection_id, is_open)
           VALUES ($1::bigint, $2, $3, $4::uuid, $5::uuid, $6)
           RETURNING id::text AS id`,
          [
            hostSteamId,
            options.mapName,
            options.region,
            options.teamId,
            options.collectionId,
            options.isOpen,
          ],
        );

        return await this.session(row.id);
      } catch (error) {
        const message = (error as Error)?.message ?? "";

        if (message.includes("utility_practice_sessions_one_live_per_host_idx")) {
          throw Error("you already have a practice session running");
        }

        if (
          attempt < 3 &&
          message.includes("utility_practice_sessions_invite_code_idx")
        ) {
          continue;
        }

        throw error;
      }
    }
  }

  // The admin client is deliberate: tbi_match's pending-match rule and
  // tai_match's auto-add-the-creator branch both key off the session role, and
  // a practice session must trip neither. The host is added to the lineup
  // explicitly below because of it.
  private async createPracticeMatch(options: {
    hostSteamId: string;
    mapName: string;
    region: string;
    serverId?: string | null;
  }): Promise<string> {
    const mapId = await this.mapId(options.mapName);

    const { insert_map_pools_one: pool } = await this.hasura.mutation({
      insert_map_pools_one: {
        __args: { object: { type: "Custom" } },
        id: true,
      },
    });

    await this.hasura.mutation({
      insert__map_pool_one: {
        __args: { object: { map_pool_id: pool.id, map_id: mapId } },
        __typename: true,
      },
    });

    const { insert_match_options_one: matchOptions } =
      await this.hasura.mutation({
        insert_match_options_one: {
          __args: {
            object: {
              type: UtilityPracticeService.MATCH_TYPE,
              // One map, no veto, best_of 1: setup_match_maps then materializes
              // exactly one match_maps row, which is what check_match_status
              // demands before the match may go Live.
              best_of: 1,
              map_veto: false,
              map_pool_id: pool.id,
              region_veto: false,
              regions: [options.region],
              number_of_substitutes: UtilityPracticeService.SUBSTITUTES,
              knife_round: false,
              overtime: false,
              coaches: false,
              mr: 12,
              tv_delay: 0,
              ready_setting: "Players",
              check_in_setting: "Players",
            },
          },
          id: true,
        },
      });

    const { insert_matches_one: match } = await this.hasura.mutation({
      insert_matches_one: {
        __args: {
          object: {
            match_options_id: matchOptions.id,
            organizer_steam_id: options.hostSteamId,
            region: options.region,
            source: "practice",
            label: "Utility Practice",
          },
        },
        id: true,
        lineup_1_id: true,
      },
    });

    await this.hasura.mutation({
      insert_match_lineup_players_one: {
        __args: {
          object: {
            match_lineup_id: match.lineup_1_id,
            steam_id: options.hostSteamId,
          },
        },
        __typename: true,
      },
    });

    if (options.serverId) {
      // Claim it here rather than leaving it to assignServer: that searches the
      // Ranked pool, which by design can never return a practice server.
      const reserved = await this.postgres.query<Array<{ id: string }>>(
        `UPDATE public.servers
            SET reserved_by_match_id = $2::uuid
          WHERE id = $1::uuid
            AND reserved_by_match_id IS NULL
        RETURNING id::text AS id`,
        [options.serverId, match.id],
      );

      if (reserved.length === 0) {
        throw Error("that practice server is already in use");
      }

      await this.postgres.query(
        "UPDATE public.matches SET server_id = $2::uuid WHERE id = $1::uuid",
        [match.id, options.serverId],
      );
    }

    const [maps] = await this.postgres.query<Array<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM public.match_maps WHERE match_id = $1::uuid",
      [match.id],
    );

    if (Number(maps.count) !== 1) {
      throw Error(
        `expected exactly one match map for a practice session, got ${maps.count}`,
      );
    }

    return match.id;
  }

  private async canJoin(
    session: UtilityPracticeSession,
    steamId: string,
  ): Promise<boolean> {
    if (session.host_steam_id === steamId) {
      return true;
    }

    if (session.is_open) {
      return true;
    }

    const [row] = await this.postgres.query<Array<{ allowed: boolean }>>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM public.utility_practice_invites i
            WHERE i.utility_practice_session_id = $1::uuid AND i.steam_id = $2::bigint
         )
         OR public.is_utility_team_member($3::uuid, $2::bigint)
         OR EXISTS (
           SELECT 1 FROM public.friends f
            WHERE f.status = 'Accepted'
              AND (
                (f.player_steam_id = $4::bigint AND f.other_player_steam_id = $2::bigint)
                OR (f.other_player_steam_id = $4::bigint AND f.player_steam_id = $2::bigint)
              )
         )
       ) AS allowed`,
      [session.id, steamId, session.team_id, session.host_steam_id],
    );

    return row?.allowed === true;
  }

  // tbid_match_lineup_players refuses a removal that would take a Live lineup
  // below the match type's minimum unless the session role is admin -- which,
  // for a Competitive-typed practice session, is every removal. The action has
  // already decided who may leave, so the statement declares the role instead
  // of depending on whatever hasura.user the pooled connection is carrying.
  private async removeFromLineup(
    matchId: string,
    steamId: string,
  ): Promise<void> {
    await this.postgres.transaction(async (client) => {
      await client.query("SELECT set_config('hasura.user', $1, false)", [
        JSON.stringify({ "x-hasura-role": "admin" }),
      ]);

      await client.query(
        `DELETE FROM public.match_lineup_players mlp
          USING public.match_lineups ml
          WHERE ml.id = mlp.match_lineup_id
            AND ml.match_id = $1::uuid
            AND mlp.steam_id = $2::bigint`,
        [matchId, steamId],
      );

      // A transaction-local set_config would leave the GUC as '' (touched but
      // empty) once the transaction ends, and ''::jsonb fails for every later
      // trigger on this pooled connection. Reset to a parseable no-user default
      // rather than unsetting it.
      await client.query("SELECT set_config('hasura.user', '{}', false)");
    });
  }

  private async hostLineupId(matchId: string): Promise<string> {
    const [row] = await this.postgres.query<Array<{ lineup_1_id: string }>>(
      "SELECT lineup_1_id::text AS lineup_1_id FROM public.matches WHERE id = $1::uuid",
      [matchId],
    );

    if (!row) {
      throw Error("practice match not found");
    }

    return row.lineup_1_id;
  }

  private async isInLineup(matchId: string, steamId: string): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ present: boolean }>>(
      `SELECT EXISTS (
         SELECT 1
           FROM public.match_lineup_players mlp
           INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
          WHERE ml.match_id = $1::uuid AND mlp.steam_id = $2::bigint
       ) AS present`,
      [matchId, steamId],
    );
    return row?.present === true;
  }

  private async isLineupFull(
    matchId: string,
    lineupId: string,
  ): Promise<boolean> {
    const [row] = await this.postgres.query<
      Array<{ used: string; max: number }>
    >(
      `SELECT (
         SELECT COUNT(*) FROM public.match_lineup_players
          WHERE match_lineup_id = $2::uuid
       ) AS used,
       public.match_max_players_per_lineup(m) AS max
       FROM public.matches m WHERE m.id = $1::uuid`,
      [matchId, lineupId],
    );

    if (!row) {
      throw Error("practice match not found");
    }

    return Number(row.used) >= Number(row.max);
  }

  private async serverIsConnected(matchId: string): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ connected: boolean }>>(
      `SELECT COALESCE(s.connected, false) AS connected
         FROM public.matches m
         INNER JOIN public.servers s ON s.id = m.server_id
        WHERE m.id = $1::uuid`,
      [matchId],
    );
    return row?.connected === true;
  }

  private async connectedPlayers(matchId: string): Promise<number> {
    const [row] = await this.postgres.query<Array<{ count: string }>>(
      `SELECT COUNT(*) AS count
         FROM public.match_lineup_players mlp
         INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE ml.match_id = $1::uuid AND mlp.is_connected = true`,
      [matchId],
    );
    return Number(row?.count ?? 0);
  }

  private async assertRole(user: User): Promise<void> {
    const minRole = ((await this.setting("public.create_matches_role")) ??
      "user") as e_player_roles_enum;

    if (!isRoleAbove(user.role, minRole)) {
      throw Error("you are not allowed to start a practice session");
    }
  }

  // An explicitly chosen server. Anything that is not a free, connected
  // practice server is rejected by name rather than silently falling back to a
  // pod, because the caller picked this one on purpose.
  // Sessions are reaped by their own status, but the claim on a dedicated
  // server outlives them: a crash between reserving one and linking its match
  // leaves a server nobody can book and nothing can free, because end() has no
  // match to cancel. A practice server is only ever held by a live practice
  // session, so anything else holding one is a leak by definition.
  private async minutes(
    name: SystemSettingName,
    fallback: number,
  ): Promise<number> {
    const raw = Number(await this.setting(name));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }

  private async anyoneWaiting(): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ waiting: boolean }>>(
      "SELECT EXISTS (SELECT 1 FROM public.utility_practice_waitlist) AS waiting",
    );
    return row?.waiting === true;
  }

  public async joinWaitlist(
    steamId: string,
    mapName: string,
    region?: string | null,
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO public.utility_practice_waitlist (steam_id, map_name, region)
       VALUES ($1, $2, $3)
       ON CONFLICT (steam_id) DO UPDATE
          SET map_name = EXCLUDED.map_name,
              region = EXCLUDED.region,
              created_at = now()`,
      [steamId, mapName, region ?? null],
    );
  }

  public async leaveWaitlist(steamId: string): Promise<void> {
    await this.postgres.query(
      "DELETE FROM public.utility_practice_waitlist WHERE steam_id = $1",
      [steamId],
    );
  }

  public async releaseOrphanedServers(): Promise<number> {
    const released = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.servers srv
          SET reserved_by_match_id = NULL
        WHERE srv.type = 'Practice'
          AND srv.reserved_by_match_id IS NOT NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM public.utility_practice_sessions s
                 WHERE s.match_id = srv.reserved_by_match_id
                   AND s.status IN ('Starting', 'Ready')
              )
      RETURNING srv.id::text AS id`,
    );

    if (released.length > 0) {
      this.logger.warn(
        `[utility-practice] released ${released.length} orphaned practice server(s)`,
      );
    }

    return released.length;
  }

  // The picker's list. Practice servers are invisible to the servers table for
  // an ordinary player -- get_server_connection_string returns null for them,
  // which is what the table's own filter keys on -- so the choice is offered
  // here, without the connect details that gate is protecting.
  public async practiceServers(user: User): Promise<
    Array<{
      id: string;
      label: string;
      region: string;
      in_use: boolean;
      held_by: string | null;
    }>
  > {
    await this.assertRole(user);

    // Busy servers are listed too, named by whoever holds them. Filtering them
    // out makes a claimed server and a missing one look identical, which is the
    // hardest state to explain to somebody staring at an empty picker.
    return await this.postgres.query(
      `SELECT s.id::text AS id,
              COALESCE(NULLIF(s.label, ''), s.host::text) AS label,
              s.region,
              s.reserved_by_match_id IS NOT NULL AS in_use,
              host.name AS held_by
         FROM public.servers s
         LEFT JOIN public.utility_practice_sessions ps
                ON ps.match_id = s.reserved_by_match_id
               AND ps.status IN ('Starting', 'Ready')
         LEFT JOIN public.players host
                ON host.steam_id = ps.host_steam_id
        WHERE s.type = 'Practice'
          AND s.enabled = true
          AND s.connected = true
        ORDER BY s.region, label`,
    );
  }

  private async practiceServer(
    serverId: string,
  ): Promise<{ id: string; region: string } | null> {
    const [row] = await this.postgres.query<
      Array<{ id: string; region: string; reserved: boolean }>
    >(
      `SELECT s.id::text AS id,
              s.region,
              s.reserved_by_match_id IS NOT NULL AS reserved
         FROM public.servers s
        WHERE s.id = $1::uuid
          AND s.type = 'Practice'
          AND s.enabled = true
          AND s.connected = true`,
      [serverId],
    );

    if (!row) {
      throw Error("that practice server is not available");
    }

    if (row.reserved) {
      throw Error("that practice server is already in use");
    }

    return { id: row.id, region: row.region };
  }

  private async freePracticeServer(
    region?: string | null,
  ): Promise<{ id: string; region: string } | null> {
    const [row] = await this.postgres.query<
      Array<{ id: string; region: string }>
    >(
      `SELECT s.id::text AS id, s.region
         FROM public.servers s
        WHERE s.type = 'Practice'
          AND s.enabled = true
          AND s.connected = true
          AND s.reserved_by_match_id IS NULL
          AND ($1::text IS NULL OR s.region = $1::text)
        ORDER BY s.region
        LIMIT 1`,
      [region ?? null],
    );

    return row ? { id: row.id, region: row.region } : null;
  }

  private async assertServerHeadroom(region: string): Promise<void> {
    const reserved = Number(
      (await this.setting(SystemSettingName.UtilityPracticeReservedServers)) ??
        "2",
    );
    const headroom = Number.isFinite(reserved) && reserved >= 0 ? reserved : 2;
    const free = await this.matchAssistant.countFreeOnDemandServers(region);

    if (free <= headroom) {
      throw Error("no practice servers are free right now");
    }
  }

  private async assertDailyLimit(steamId: string): Promise<void> {
    const limit = Number(
      (await this.setting(SystemSettingName.UtilityPracticeDailyLimit)) ?? "10",
    );

    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    const [row] = await this.postgres.query<Array<{ count: string }>>(
      `SELECT COUNT(*) AS count FROM public.utility_practice_sessions
        WHERE host_steam_id = $1::bigint
          AND created_at > now() - interval '1 day'`,
      [steamId],
    );

    if (Number(row.count) >= limit) {
      throw Error("you have started too many practice sessions today");
    }
  }

  private async resolveMap(mapName: string): Promise<string> {
    const [row] = await this.postgres.query<Array<{ name: string }>>(
      `SELECT name FROM public.maps
        WHERE name = $1 AND type = $2 AND enabled = true
        LIMIT 1`,
      [mapName, UtilityPracticeService.MATCH_TYPE],
    );

    if (!row) {
      throw Error("that map is not available for practice");
    }

    return row.name;
  }

  private async mapId(mapName: string): Promise<string> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id FROM public.maps
        WHERE name = $1 AND type = $2 LIMIT 1`,
      [mapName, UtilityPracticeService.MATCH_TYPE],
    );

    if (!row) {
      throw Error("that map is not available for practice");
    }

    return row.id;
  }

  private async resolveRegion(region?: string | null): Promise<string> {
    if (region) {
      const [row] = await this.postgres.query<Array<{ value: string }>>(
        "SELECT value FROM public.server_regions WHERE value = $1 LIMIT 1",
        [region],
      );

      if (!row) {
        throw Error("unknown region");
      }

      return row.value;
    }

    const [row] = await this.postgres.query<Array<{ region: string }>>(
      `SELECT s.region
         FROM public.servers s
         INNER JOIN public.server_regions sr ON sr.value = s.region
        WHERE s.enabled = true
          AND s.type = 'Ranked'
          AND s.is_dedicated = false
          AND s.reserved_by_match_id IS NULL
          AND sr.is_lan = false
        GROUP BY s.region
        ORDER BY COUNT(*) DESC
        LIMIT 1`,
    );

    if (!row) {
      throw Error("no practice servers are free right now");
    }

    return row.region;
  }

  private async setting(name: string): Promise<string | null> {
    const [row] = await this.postgres.query<Array<{ value: string }>>(
      "SELECT value FROM public.settings WHERE name = $1 LIMIT 1",
      [name],
    );
    return row?.value ?? null;
  }
}
