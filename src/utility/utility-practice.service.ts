import { Injectable, Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { HasuraService } from "../hasura/hasura.service";
import { PostgresService } from "../postgres/postgres.service";
import { CacheService } from "../cache/cache.service";
import { MatchAssistantService } from "../matches/match-assistant/match-assistant.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
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
import {
  UtilityLoadService,
  UtilityScratchLineup,
} from "./utility-load.service";
import { UtilityPracticeModeService } from "./utility-practice-mode.service";

export type UtilityPracticeSession = {
  id: string;
  match_id: string | null;
  host_steam_id: string | null;
  team_id: string | null;
  map_name: string;
  region: string | null;
  collection_id: string | null;
  playbook_id: string | null;
  status: string;
  invite_code: string;
  is_open: boolean;
  access: string | null;
  is_render: boolean;
  last_occupied_at: Date | null;
  empty_since: Date | null;
  expires_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
};

export type ChangeUtilityPracticeMapInput = {
  session_id: string;
  map_name: string;
  /** Stand the caller on this once the new map is up. */
  lineup_id?: string | null;
  /** Or drill this set, in the order given. */
  lineup_ids?: Array<string> | null;
  /** Or a throw with no row behind it -- a mined spot, or a draft. */
  scratch?: UtilityScratchLineup | null;
};

export type ChangeUtilityPracticeMapResult = {
  success: boolean;
  map_name: string;
  /** False when the server took the map change but not the queued load. */
  queued: boolean;
};

export type StartUtilityPracticeInput = {
  map_name: string;
  region?: string | null;
  collection_id?: string | null;
  team_id?: string | null;
  is_open?: boolean;
  access?: string;
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
  // A render batch that has not finished in this long is not going to; the
  // server it is holding is worth more than the last few clips.
  public static readonly RENDER_GRACE_MINUTES = 90;

  private readonly appConfig: AppConfig;
  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly hasura: HasuraService,
    private readonly cache: CacheService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly playbooks: UtilityPlaybooksService,
    private readonly notifications: NotificationsService,
    private readonly load: UtilityLoadService,
    private readonly practiceMode: UtilityPracticeModeService,
    private readonly configService: ConfigService,
    private readonly redisManager: RedisManagerService,
  ) {
    this.appConfig = this.configService.get<AppConfig>("app");
    this.redis = this.redisManager.getConnection();
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
    await this.assertNotBusy(user);

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
      //
      // A named region is the ON DEMAND answer and nothing else. The picker
      // lists every standing practice server as a row of its own, so a caller
      // who wanted the box in US-EAST asked for it by id; one who picked
      // US-EAST out of the region group asked for a pod to be booted there.
      // Substituting the standing box handed back a server nobody asked for --
      // and if it is not actually up, one that never answers. Only the
      // automatic choice may take a standing one, which is what its own hint
      // promises: "a free practice server if one is standing, otherwise a
      // fresh one".
      const server = input.server_id
        ? await this.practiceServer(input.server_id)
        : input.region
          ? null
          : await this.freePracticeServer(null);

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


      const access = UtilityPracticeService.accessFor(input);

      const session = await this.insertSession(user.steam_id, {
        mapName,
        region,
        teamId: input.team_id ?? null,
        collectionId: input.collection_id ?? null,
        // is_open is kept in step with access rather than read: everything
        // decides on access now, and a column two things can disagree about is
        // a bug waiting for whichever one is checked second.
        isOpen: access === "Open",
        access,
      });

      try {
        const matchId = await this.createPracticeMatch({
          organizerSteamId: user.steam_id,
          mapName,
          region,
          serverId: server?.id ?? null,
        });

        await this.postgres.query(
          "UPDATE public.utility_practice_sessions SET match_id = $2::uuid WHERE id = $1::uuid",
          [session.id, matchId],
        );

        await this.matchAssistant.updateMatchStatus(matchId, "Live");

        // A dedicated practice server is already running and has already asked
        // for a session once -- and been told there wasn't one. Nothing else
        // tells it otherwise until a map change, so the roster it is holding
        // stays empty and the host cannot get in.
        await this.matchAssistant.sendUtilityPracticeRefresh(matchId);

        return await this.session(session.id);
      } catch (error) {
        await this.fail(session.id, (error as Error)?.message ?? "unknown");
        throw error;
      }
    } finally {
      await this.cache.forget(lockKey);
    }
  }

  /**
   * The same server booking as start(), minus everything that is about a
   * person: no role gate, no busy check, no waitlist, no lock keyed on a human.
   * A render session is booked BY the api, its host is only the steam id the
   * host_steam_id foreign key demands, and it holds the server for exactly as
   * long as the batch takes.
   */
  public async startForRender(options: {
    mapName: string;
    // Who asked for the render -- used only as the match organizer (that column
    // is NOT NULL) and for recovery/audit. The SESSION itself is host-less:
    // system-owned, so it never reads as this person's practice server.
    requestedBySteamId: string;
    region?: string | null;
  }): Promise<UtilityPracticeSession> {
    if (!(await this.isEnabled())) {
      throw Error("utility practice is not enabled");
    }

    const mapName = await this.resolveMap(options.mapName);

    // Deliberately NOT freePracticeServer(). A render books its own server on a
    // game server node, every time. Reusing a "free" one drops the pod onto a
    // server people are already on: an idle practice server is not an empty
    // one, and the pod does not behave like a guest -- it teleports itself
    // around, throws grenades, and re-presses jointeam until it spawns, which
    // respawns whoever else is standing there.
    const region = await this.resolveRegion(options.region);

    // A preview clip is never worth the last free slot -- the same reserve a
    // player's session respects.
    await this.assertServerHeadroom(region);

    const session = await this.insertSession(null, {
      mapName,
      region,
      teamId: null,
      collectionId: null,
      isOpen: false,
      // A render pod is nobody's to join.
      access: "Private",
      isRender: true,
    });

    try {
      const matchId = await this.createPracticeMatch({
        organizerSteamId: options.requestedBySteamId,
        mapName,
        region,
        serverId: null,
        isRender: true,
      });

      await this.postgres.query(
        "UPDATE public.utility_practice_sessions SET match_id = $2::uuid WHERE id = $1::uuid",
        [session.id, matchId],
      );

      await this.matchAssistant.updateMatchStatus(matchId, "Live");
      await this.matchAssistant.sendUtilityPracticeRefresh(matchId);

      return await this.session(session.id);
    } catch (error) {
      await this.fail(session.id, (error as Error)?.message ?? "unknown");
      throw error;
    }
  }

  /**
   * Where the render pod connects. The raw match password is the credential:
   * PracticeConnectUtility.Authorize() takes it as proof on its own, which is
   * what lets a pod that is on nobody's roster onto the server.
   */
  public async renderConnection(sessionId: string): Promise<{
    addr: string;
    password: string;
    match_id: string;
    plugin_runtime: string;
  } | null> {
    // A render pod is NOT an internet player, and the address a player would
    // use is wrong for it three ways over, all proven on a live pod:
    //   - the Steam relay token (get_server_host) -> the LAN-only anonymous
    //     server refuses relay, and cs2 falls back to its own loopback map;
    //   - the public host:port -> NAT hairpin, dropped by the router;
    //   - the node mesh IP -> the server answers only a challenge, not the
    //     connect.
    // The render pod and its practice server share ONE node's host network
    // (both hostNetwork, and a render's server is co-located on the render's
    // node), and an A2S query to 127.0.0.1:<port> from the pod returns the
    // server's full info. Loopback also counts as LAN, so the LAN-only server
    // accepts it. So: connect over the loopback they share.
    const [row] = await this.postgres.query<
      Array<{
        match_id: string;
        password: string;
        port: number | null;
        plugin_runtime: string;
      }>
    >(
      `SELECT m.id::text AS match_id,
              m.password,
              srv.port,
              COALESCE(n.pin_plugin_runtime, public.active_plugin_runtime())
                AS plugin_runtime
         FROM public.utility_practice_sessions s
         INNER JOIN public.matches m ON m.id = s.match_id
         INNER JOIN public.servers srv ON srv.id = m.server_id
          LEFT JOIN public.game_server_nodes n ON n.id = srv.game_server_node_id
        WHERE s.id = $1::uuid`,
      [sessionId],
    );

    if (!row?.password || !row?.port) {
      return null;
    }

    return {
      addr: `127.0.0.1:${row.port}`,
      password: row.password,
      match_id: row.match_id,
      plugin_runtime: row.plugin_runtime,
    };
  }

  public async endRenderSession(sessionId: string): Promise<void> {
    await this.end(await this.session(sessionId), "Ended");
  }

  // Backstop for a batch job that died holding a server. The batch itself ends
  // its session; this only catches the ones nothing is watching any more.
  public async reapRenderSessions(): Promise<number> {
    const stale = await this.postgres.query<Array<{ id: string }>>(
      `SELECT s.id::text AS id
         FROM public.utility_practice_sessions s
        WHERE s.is_render = true
          AND s.status IN ('Starting', 'Ready')
          AND s.created_at < now() - make_interval(mins => $1)
          AND NOT EXISTS (
            SELECT 1
              FROM public.utility_lineup_renders r
             WHERE r.utility_practice_session_id = s.id
               AND r.status IN ('queued', 'rendering', 'uploading')
          )`,
      [UtilityPracticeService.RENDER_GRACE_MINUTES],
    );

    for (const row of stale) {
      await this.endRenderSession(row.id);
    }

    return stale.length;
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

    // Only once they are actually about to be added: the re-join above is the
    // same player already on this roster, and this session is itself a match
    // they would otherwise be judged "busy" by.
    await this.assertNotBusy(user);

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
    // INCR rather than get-then-put: guesses fired concurrently all read the
    // same pre-increment value, and a limit that only counts the attempts that
    // happened to be serialised is not a limit. EXPIRE has to follow INCR --
    // on a key that does not exist yet it does nothing, which would leave the
    // counter with no TTL at all.
    const result = await this.redis.multi().incr(key).expire(key, 120).exec();

    const count = Number(result?.[0]?.[1] ?? 0);

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

  // The plugin polls, so this runs on every GET /utility/session. The status
  // guard is what makes that idempotent: only a row still in 'Starting' is
  // moved.
  public async markReady(matchId: string): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_practice_sessions
          SET status = 'Ready', failure_reason = NULL, last_occupied_at = now()
        WHERE match_id = $1::uuid AND status = 'Starting'`,
      [matchId],
    );
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
    status: string;
  } | null> {
    const [row] = await this.postgres.query<
      Array<{
        session_id: string;
        match_id: string;
        map_name: string;
        password: string;
        status: string;
      }>
    >(
      `SELECT s.id::text AS session_id,
              m.id::text AS match_id,
              s.map_name,
              m.password,
              s.status
         FROM public.servers srv
         INNER JOIN public.matches m ON m.id = srv.reserved_by_match_id
         INNER JOIN public.utility_practice_sessions s ON s.match_id = m.id
        WHERE srv.id = $1::uuid
          AND s.status IN ('Starting', 'Ready')`,
      [serverId],
    );

    return row ?? null;
  }

  /**
   * Record where a practice pod can be reached over Steam's relay network.
   *
   * Nothing else ever writes this for a practice server: the match plugin's
   * ping is what maintains it everywhere else, and a practice pod does not run
   * the match plugin. Deliberately not that endpoint either -- it also writes
   * plugin_version and plugin_runtime, which decide how the panel talks to a
   * server, and the utility plugin's version is not the answer to that.
   *
   * A null is "nothing to say", never "clear it": a pod still registering with
   * the relay would otherwise flap the address out from under a player joining.
   * The stale value that caused the original bug is cleared when the row is
   * reserved, which is the moment it is known to be wrong.
   */
  private async reportSteamRelay(
    serverId: string,
    steamRelay: string | null,
  ): Promise<void> {
    if (!steamRelay) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.servers
          SET steam_relay = $2
        WHERE id = $1::uuid
          AND steam_relay IS DISTINCT FROM $2`,
      [serverId, steamRelay],
    );
  }

  /**
   * Tell every practice server sitting on a map that its library is out of
   * date.
   *
   * The plugin caches the library per player and only re-reads it when it is
   * asked to, so a lineup written or edited on the website was invisible in
   * game until somebody typed .reload -- which is not something a player knows
   * to do, and is the in-game half of "the panel doesn't auto refresh". Scoped
   * to the map because a lineup on Ancient is nothing to a server on Mirage.
   */
  public async refreshLibrariesOnMap(mapName: string): Promise<void> {
    if (!mapName) {
      return;
    }

    const rows = await this.postgres.query<Array<{ match_id: string }>>(
      `SELECT m.id::text AS match_id
         FROM public.utility_practice_sessions s
         INNER JOIN public.matches m ON m.id = s.match_id
        WHERE s.map_name = $1
          AND s.map_changing_at IS NULL
          AND s.status IN ('Starting', 'Ready')`,
      [mapName],
    );

    for (const row of rows) {
      await this.matchAssistant.sendUtilityPracticeRefresh(row.match_id);
    }
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

    // is_render is excluded on purpose: the connect grace and the idle clock
    // both describe a player who booked a server and left, and neither
    // describes a pod that is still installing cs2. BatchUtilityRenderJob owns
    // a render session's lifetime, with reapRenderSessions as the backstop.
    const sessions = await this.postgres.query<Array<UtilityPracticeSession>>(
      `${UtilityPracticeService.SELECT}
        WHERE s.status IN ('Starting', 'Ready') AND s.is_render = false`,
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
           s.access,
           s.is_render,
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

  // Old callers sent is_open and nothing else; new ones send access. Closed
  // meant friends-team-and-invited, so that is what it maps to.
  private static accessFor(input: { access?: string; is_open?: boolean }): string {
    const allowed = ["Open", "Friends", "Invite", "Private"];

    if (input.access && allowed.includes(input.access)) {
      return input.access;
    }

    return input.is_open === true ? "Open" : "Friends";
  }

  private async insertSession(
    hostSteamId: string | null,
    options: {
      mapName: string;
      region: string;
      teamId: string | null;
      collectionId: string | null;
      isOpen: boolean;
      access: string;
      isRender?: boolean;
    },
  ): Promise<UtilityPracticeSession> {
    // generate_utility_invite_code() is 50 bits, so a collision is vanishingly
    // rare -- but the uniqueness index only covers live sessions, so it is not
    // impossible, and it must read as "try again", not as a failed start.
    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await this.postgres.query<Array<{ id: string }>>(
          `INSERT INTO public.utility_practice_sessions
             (host_steam_id, map_name, region, team_id, collection_id, is_open,
              access, is_render)
           VALUES ($1::bigint, $2, $3, $4::uuid, $5::uuid, $6, $7, $8)
           RETURNING id::text AS id`,
          [
            hostSteamId,
            options.mapName,
            options.region,
            options.teamId,
            options.collectionId,
            options.isOpen,
            options.access,
            options.isRender === true,
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
    // A human session's host, or the requester for a render. Either way this is
    // the match's organizer (matches.organizer_steam_id is NOT NULL).
    organizerSteamId: string;
    mapName: string;
    region: string;
    serverId?: string | null;
    isRender?: boolean;
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

    // Without a mode the server boots a plain Competitive config: rounds end,
    // freezetime applies and grenades are limited, which is every one of the
    // things a practice server exists not to do.
    const mode = await this.practiceMode.ensureMode();

    const { insert_match_options_one: matchOptions } =
      await this.hasura.mutation({
        insert_match_options_one: {
          __args: {
            object: {
              ...(mode ? { game_mode_id: mode.id } : {}),
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
            organizer_steam_id: options.organizerSteamId,
            region: options.region,
            source: "practice",
            label: "Utility Practice",
          },
        },
        id: true,
        lineup_1_id: true,
      },
    });

    // A human practice match seats its host in the lineup so the roster lets
    // them in. A render has no human on the roster -- the pod authorizes on the
    // match password -- so seating one would only re-introduce a person the
    // session was made not to have.
    if (!options.isRender) {
      await this.hasura.mutation({
        insert_match_lineup_players_one: {
          __args: {
            object: {
              match_lineup_id: match.lineup_1_id,
              steam_id: options.organizerSteamId,
            },
          },
          __typename: true,
        },
      });
    }

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

    const access = session.access ?? "Friends";

    if (access === "Open") {
      return true;
    }

    // Nobody but the host, and no query worth running to prove it.
    if (access === "Private") {
      return false;
    }

    // Invite and Friends share the invite/team half; only Friends adds the
    // host's friend list on top. Written as one query with a flag rather than
    // two, so the two paths cannot drift apart.
    const friends = access === "Friends";

    const [row] = await this.postgres.query<Array<{ allowed: boolean }>>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM public.utility_practice_invites i
            WHERE i.utility_practice_session_id = $1::uuid AND i.steam_id = $2::bigint
         )
         OR public.is_utility_team_member($3::uuid, $2::bigint)
         OR (
           $5::boolean
           AND EXISTS (
             SELECT 1 FROM public.friends f
              WHERE f.status = 'Accepted'
                AND (
                  (f.player_steam_id = $4::bigint AND f.other_player_steam_id = $2::bigint)
                  OR (f.other_player_steam_id = $4::bigint AND f.player_steam_id = $2::bigint)
                )
           )
         )
       ) AS allowed`,
      [session.id, steamId, session.team_id, session.host_steam_id, friends],
    );

    return row?.allowed === true;
  }

  /**
   * Who may join, changed after the fact. The old model could only be set at
   * start time, so a host who opened a server to everybody had no way to close
   * it again without stopping it.
   */
  // A changelevel drops everyone on the server into a load screen, so two of
  // them stacked by a double-clicked button is a server that never finishes
  // loading anything.
  private static readonly MAP_CHANGE_LOCK_SECONDS = 20;

  /**
   * Move a running practice server onto another map, optionally handing the
   * plugin something to stand the caller on once it is up.
   *
   * The map lives in three places and they have to move together: the session
   * row (which is what the plugin's roster fetch and the website read), the
   * match's one `match_maps` row (which is what `serverContext` -- and
   * therefore the library, ingest and trajectory endpoints -- reads), and the
   * Custom map pool behind it.
   */
  public async changeMap(
    user: User,
    input: ChangeUtilityPracticeMapInput,
  ): Promise<ChangeUtilityPracticeMapResult> {
    const session = await this.session(input.session_id);

    if (!session) {
      throw Error("practice session not found");
    }

    if (
      session.host_steam_id !== user.steam_id &&
      !isRoleAbove(user.role, "administrator")
    ) {
      throw Error("only the host can change this practice server's map");
    }

    // A render session is filming a fixed list of lineups on one map; moving it
    // would abandon the batch it was booked for.
    if (session.is_render) {
      throw Error("that practice session is not yours to change");
    }

    // A Starting session's pod has +map baked into its job args -- there is no
    // level running yet for a changelevel to replace.
    if (session.status !== "Ready" || !session.match_id) {
      throw Error("that practice server is not ready yet");
    }

    const map = await this.resolveMapRow(input.map_name);

    // Already on that map, so there is no level to change -- but the caller
    // asked to be stood on something, and reporting success without sending it
    // leaves them watching a button that says it worked from the wrong spot.
    if (map.name === session.map_name) {
      const serverId = await this.serverForSession(session.match_id);
      const queued = await this.queueForMapChange(
        user,
        serverId,
        map.name,
        input,
      );

      return {
        success: true,
        map_name: map.name,
        queued: await this.load.sendQueued(serverId, user.steam_id, queued),
      };
    }

    const lockKey = `utility:practice:map:${session.id}`;

    if (
      !(await this.cache.acquireLock(
        lockKey,
        UtilityPracticeService.MAP_CHANGE_LOCK_SECONDS,
      ))
    ) {
      throw Error("that server is already changing map");
    }

    try {
      const serverId = await this.serverForSession(session.match_id);

      // Before the level changes, not after: a throw the caller may not see is
      // a refusal, and refusing after everyone is already in a load screen is
      // the worst possible moment to find out.
      const queued = await this.queueForMapChange(
        user,
        serverId,
        map.name,
        input,
      );

      await this.postgres.transaction(async (client) => {
        // playbook_id goes with it: an execute is a statement about one map.
        // last_occupied_at keeps the reaper's idle clock off the load screen --
        // tbiu_utility_practice_sessions clears empty_since from that column.
        await client.query(
          `UPDATE public.utility_practice_sessions
              SET map_name = $2,
                  map_changing_at = now(),
                  playbook_id = NULL,
                  last_occupied_at = now()
            WHERE id = $1::uuid`,
          [session.id, map.name],
        );

        const moved = await client.query(
          `UPDATE public.match_maps
              SET map_id = $2::uuid
            WHERE match_id = $1::uuid
          RETURNING id`,
          [session.match_id, map.id],
        );

        if (moved.rowCount !== 1) {
          throw Error(
            `expected exactly one match map for a practice session, moved ${moved.rowCount}`,
          );
        }

        // The pool is what materialized that match map. Leaving it on the old
        // map means the two disagree about what this session is for.
        await client.query(
          `UPDATE public._map_pool mp
              SET map_id = $2::uuid
             FROM public.matches m
             INNER JOIN public.match_options mo ON mo.id = m.match_options_id
            WHERE m.id = $1::uuid
              AND mp.map_pool_id = mo.map_pool_id`,
          [session.match_id, map.id],
        );
      });

      const sent = await this.load.changeMap({
        serverId,
        mapName: map.name,
        workshopId: map.workshop_map_id,
        steamId: user.steam_id,
        lineupIds: queued,
      });

      if (!sent.sent) {
        // The row now claims a map the server was never told about, and every
        // read would be answered for a level it is not running.
        await this.abandonMapChange(session);
        throw Error("could not reach your practice server");
      }

      this.logger.log(
        `[utility-practice ${session.id}] ${session.map_name} -> ${map.name} ` +
          `by ${user.steam_id}`,
      );

      return { success: true, map_name: map.name, queued: sent.queued };
    } finally {
      await this.cache.forget(lockKey);
    }
  }

  /**
   * What the plugin should stand the caller on once the new map is up, put into
   * their library on the way through.
   *
   * The library entry is the load-bearing half: the plugin refetches on map
   * load and only teleports somebody onto a lineup it can find, so a Public
   * lineup nobody has favourited would otherwise arrive as an id belonging to
   * nothing. UtilityLoadService.PENDING_SECONDS is thirty minutes precisely so
   * it outlives a changelevel.
   */
  private async queueForMapChange(
    user: User,
    serverId: string,
    mapName: string,
    input: ChangeUtilityPracticeMapInput,
  ): Promise<Array<string>> {
    if (input.scratch) {
      if (input.scratch.map_name !== mapName) {
        throw Error("that throw is for another map");
      }

      await this.load.remember(serverId, user.steam_id, {
        kind: "scratch",
        lineup: input.scratch,
      });

      return [input.scratch.client_id];
    }

    const asked = [
      ...new Set(
        [input.lineup_id, ...(input.lineup_ids ?? [])].filter(
          (id): id is string => !!id,
        ),
      ),
    ].slice(0, UtilityLoadService.MAX_DRILL);

    if (asked.length === 0) {
      return [];
    }

    const allowed = await this.load.visibleOnMap(user, asked, mapName);

    // Order is the caller's: a drill runs in the sequence they chose.
    const queue = asked.filter((id) => allowed.has(id));

    if (queue.length === 0) {
      throw Error("that lineup is not available to you on that map");
    }

    for (const id of queue) {
      await this.load.remember(serverId, user.steam_id, {
        kind: "saved",
        lineup_id: id,
      });
    }

    return queue;
  }

  /** Put a session back on the map it was on, after a change nobody received. */
  private async abandonMapChange(
    session: UtilityPracticeSession,
  ): Promise<void> {
    try {
      const previous = await this.resolveMapRow(session.map_name);

      await this.postgres.transaction(async (client) => {
        await client.query(
          `UPDATE public.utility_practice_sessions
              SET map_name = $2, map_changing_at = NULL
            WHERE id = $1::uuid`,
          [session.id, previous.name],
        );
        await client.query(
          `UPDATE public.match_maps SET map_id = $2::uuid WHERE match_id = $1::uuid`,
          [session.match_id, previous.id],
        );
        await client.query(
          `UPDATE public._map_pool mp
              SET map_id = $2::uuid
             FROM public.matches m
             INNER JOIN public.match_options mo ON mo.id = m.match_options_id
            WHERE m.id = $1::uuid
              AND mp.map_pool_id = mo.map_pool_id`,
          [session.match_id, previous.id],
        );
      });
    } catch (error) {
      this.logger.error(
        `[utility-practice ${session.id}] could not undo a map change: ` +
          (error as Error)?.message,
      );
    }
  }

  /**
   * The plugin fetches its session on every map load, naming the map it came up
   * on. That is the only honest signal the level actually finished loading --
   * everything else is a guess at how long a changelevel takes.
   *
   * A build that does not name one clears the flag anyway: an old plugin is
   * still a server that is up, and a flag that never clears would leave every
   * "load me in" button refusing forever.
   */
  public async markMapLoaded(
    sessionId: string,
    reportedMap?: string | null,
  ): Promise<void> {
    await this.postgres.query(
      `UPDATE public.utility_practice_sessions
          SET map_changing_at = NULL
        WHERE id = $1::uuid
          AND map_changing_at IS NOT NULL
          AND ($2::text IS NULL OR map_name = $2::text)`,
      [sessionId, reportedMap ?? null],
    );
  }

  private async serverForSession(matchId: string): Promise<string> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id::text AS id
         FROM public.servers
        WHERE reserved_by_match_id = $1::uuid
        LIMIT 1`,
      [matchId],
    );

    if (!row) {
      throw Error("that practice session has no server");
    }

    return row.id;
  }

  public async setAccess(
    user: User,
    sessionId: string,
    access: string,
  ): Promise<{ success: boolean }> {
    const allowed = ["Open", "Friends", "Invite", "Private"];

    if (!allowed.includes(access)) {
      throw Error("unknown access level");
    }

    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.utility_practice_sessions
          SET access = $3, is_open = ($3 = 'Open'), updated_at = now()
        WHERE id = $1::uuid
          AND host_steam_id = $2::bigint
          AND status IN ('Starting', 'Ready')
        RETURNING id::text AS id`,
      [sessionId, user.steam_id, access],
    );

    if (!row) {
      throw Error("that is not your practice session");
    }

    return { success: true };
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

  // Who is actually standing on the practice server. A match server reports
  // this over the match-events socket, which a practice server has no channel
  // to -- so without this every session reads as empty and the reaper ends it
  // while somebody is mid-throw.
  //
  // The plugin posts this the tick after anybody connects or disconnects, and
  // then on a slow timer as a reconciler. The snapshot is idempotent either
  // way, which is what lets a missed post heal itself.
  public async reportOccupancy(
    serverId: string,
    steamIds: Array<string>,
    steamRelay: string | null = null,
  ): Promise<void> {
    // Independent of the session: a pod reports where it can be reached
    // whether or not anyone is on it yet, and the connect string is read
    // before the first player arrives.
    await this.reportSteamRelay(serverId, steamRelay);

    const session = await this.liveSessionForServer(serverId);

    if (!session) {
      return;
    }

    const present = steamIds
      .map((steamId) => String(steamId ?? "").trim())
      .filter((steamId) => /^\d{5,20}$/.test(steamId));

    // RETURNING pairs with the IS DISTINCT FROM filter: the rows that come back
    // are exactly the players whose presence actually flipped, in either
    // direction. A reconciling post that finds nothing changed returns nothing
    // and so pushes nothing.
    const flipped = await this.postgres.query<Array<{ steam_id: string }>>(
      `UPDATE public.match_lineup_players mlp
          SET is_connected = (mlp.steam_id::text = ANY ($2::text[]))
         FROM public.match_lineups ml
        WHERE ml.id = mlp.match_lineup_id
          AND ml.match_id = $1::uuid
          AND mlp.is_connected IS DISTINCT FROM (mlp.steam_id::text = ANY ($2::text[]))
      RETURNING mlp.steam_id::text AS steam_id`,
      [session.match_id, present],
    );

    // The second proof that the server is up, and the reason there has to be
    // one: GET /utility/session is asked once, at map load, and a plugin whose
    // first ask failed never asks again -- leaving a session Starting behind a
    // server that is running and talking. A practice pod does not ping
    // /game-server-node, so nothing else would ever notice. This tick is the
    // plugin on a loaded map, which is all Ready has ever meant.
    //
    // Behind the roster write and behind the status the session row already
    // reported: the reaper reads is_connected, so a throw here must not be
    // what leaves an occupied session looking empty.
    if (session.status === "Starting") {
      await this.markReady(session.match_id);
    }

    await this.pushWhereAmI(flipped.map(({ steam_id }) => steam_id));

    if (present.length > 0) {
      await this.postgres.query(
        `UPDATE public.utility_practice_sessions
            SET first_joined_at = COALESCE(first_joined_at, now())
          WHERE id = $1::uuid`,
        [session.session_id],
      );
      await this.touch(session.session_id);
    }
  }

  /**
   * Tell each player whose presence just flipped, so the website stops asking.
   *
   * Rides send-message-to-steam-id so it reaches their tabs on any api pod, and
   * carries the payload rather than a bare nudge because this channel targets
   * one player's own sockets -- unlike camera-status, which is cluster-wide and
   * therefore has to make everyone re-read through an authorized endpoint.
   */
  private async pushWhereAmI(steamIds: Array<string>): Promise<void> {
    for (const steamId of steamIds) {
      try {
        await this.redis.publish(
          "send-message-to-steam-id",
          JSON.stringify({
            steamId,
            event: "utility:where",
            data: await this.load.whereAmI(steamId),
          }),
        );
      } catch (error) {
        // A push that cannot be delivered must not fail the occupancy post:
        // the write already landed, and the next reconciling snapshot is what
        // the timer is there for.
        this.logger.warn(
          `unable to push practice location to ${steamId}: ${
            (error as Error)?.message
          }`,
        );
      }
    }
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

  // Booking a practice server is a reservation, so it answers to the same
  // question matchmaking asks: is this player free? A player already on a
  // server cannot be on a second one, and holding a practice server while a
  // real match wants them is how a match ends up a man down.
  // A real match outranks a practice server. Rather than refuse the session,
  // the match evicts it when it actually claims the player -- which is what
  // lets somebody practise in the gap before a scheduled match without the
  // usual buffer locking them out.
  public static readonly CLAIMING_STATUSES: ReadonlyArray<string> = [
    "Live",
    "Veto",
    "WaitingForCheckIn",
    "WaitingForServer",
  ];

  public async evictForMatch(matchId: string): Promise<number> {
    const players = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT mlp.steam_id::text AS steam_id
         FROM public.match_lineup_players mlp
         INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE ml.match_id = $1::uuid`,
      [matchId],
    );

    let evicted = 0;

    for (const { steam_id } of players) {
      // Hosting one means the server goes back; merely being on someone else's
      // roster only means leaving it, and their session carries on without them.
      const [hosted] = await this.postgres.query<Array<{ id: string }>>(
        `SELECT id::text AS id
           FROM public.utility_practice_sessions
          WHERE host_steam_id = $1
            AND status IN ('Starting', 'Ready')
          LIMIT 1`,
        [steam_id],
      );

      if (hosted) {
        await this.end(await this.session(hosted.id), "Ended");
        evicted++;
        continue;
      }

      const [joined] = await this.postgres.query<
        Array<{ id: string; match_id: string | null }>
      >(
        `SELECT s.id::text AS id, s.match_id::text AS match_id
           FROM public.utility_practice_sessions s
           INNER JOIN public.match_lineups ml ON ml.match_id = s.match_id
           INNER JOIN public.match_lineup_players mlp
                   ON mlp.match_lineup_id = ml.id AND mlp.steam_id = $1
          WHERE s.status IN ('Starting', 'Ready')
          LIMIT 1`,
        [steam_id],
      );

      if (joined?.match_id) {
        await this.removeFromLineup(joined.match_id, steam_id);
        await this.matchAssistant.sendUtilityPracticeRefresh(joined.match_id);
        evicted++;
      }
    }

    if (evicted > 0) {
      this.logger.log(
        `[utility-practice] match ${matchId} evicted ${evicted} practice player(s)`,
      );
    }

    return evicted;
  }

  private async assertNotBusy(user: User): Promise<void> {
    const [player] = await this.postgres.query<
      Array<{ is_banned: boolean; in_another_match: boolean }>
    >(
      `SELECT p.is_banned,
              EXISTS (
                SELECT 1
                  FROM public.match_lineup_players mlp
                  INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
                  INNER JOIN public.matches m ON m.id = ml.match_id
                 WHERE mlp.steam_id = p.steam_id
                   AND m.source <> 'practice'
                   AND m.status = ANY ($2::text[])
              ) AS in_another_match
         FROM public.players p
        WHERE p.steam_id = $1`,
      [user.steam_id, [...UtilityPracticeService.CLAIMING_STATUSES]],
    );

    if (!player) {
      throw Error("player not found");
    }

    if (player.is_banned) {
      throw Error("you are banned");
    }

    // Queuing is deliberately not a blocker: a match that pops evicts the
    // practice session anyway, and refusing to let somebody drill while they
    // search is the buffer this model exists to remove.
    if (player.in_another_match) {
      throw Error("you are already in a match");
    }
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

  private async resolveMap(mapName: string): Promise<string> {
    return (await this.resolveMapRow(mapName)).name;
  }

  /**
   * A map a practice session may be on. Everything a change needs is here,
   * because the id is what `match_maps` and the pool take while the name is
   * what the session row and the plugin take, and reading them separately is
   * how the two end up describing different maps.
   *
   * deleted_at is excluded: tau_maps_soft_delete strips a deleted map out of
   * every pool, so pointing a pool row at one is a write the database undoes.
   */
  private async resolveMapRow(mapName: string): Promise<{
    id: string;
    name: string;
    workshop_map_id: string | null;
  }> {
    const [row] = await this.postgres.query<
      Array<{ id: string; name: string; workshop_map_id: string | null }>
    >(
      `SELECT id::text AS id, name, workshop_map_id
         FROM public.maps
        WHERE name = $1
          AND type = $2
          AND enabled = true
          AND deleted_at IS NULL
        LIMIT 1`,
      [mapName, UtilityPracticeService.MATCH_TYPE],
    );

    if (!row) {
      throw Error("that map is not available for practice");
    }

    return row;
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
