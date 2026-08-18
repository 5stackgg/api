import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { HasuraService } from "../hasura/hasura.service";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import {
  e_notification_types_enum,
  e_player_roles_enum,
} from "generated/schema";
import { isRoleAbove, rolesAtOrAbove } from "src/utilities/isRoleAbove";
import { NotificationsService } from "src/notifications/notifications.service";
import { PostgresService } from "src/postgres/postgres.service";
import { chatThreadKey } from "src/notifications/push/notification-delivery";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { parseDirectRoomId } from "./utilities/directRoomId";
@Injectable()
export class ChatService {
  private redis: Redis;

  // How long a room's messages survive in redis, per lobby type. Match chatter
  // and a tournament's announcements are not the same thing and never wanted
  // the same lifetime; the single setting they shared could not say so.
  //
  // Direct is absent deliberately -- DMs live in postgres, and their retention
  // is a sweep rather than a TTL. See sendMessageToChat.
  private ttls = new Map<ChatLobbyType, number>([
    [ChatLobbyType.Match, 60 * 60],
    [ChatLobbyType.MatchTeam, 60 * 60],
    [ChatLobbyType.MatchMaking, 60 * 60],
    [ChatLobbyType.Draft, 60 * 60],
    [ChatLobbyType.Tournament, 60 * 60 * 24],
    [ChatLobbyType.Organizer, 60 * 60 * 24],
  ]);

  private static readonly DEFAULT_TTL = 60 * 60;

  // Which setting governs which room's lifetime, and what it falls back to.
  // Read from system/ on boot and whenever a setting changes, so there is one
  // list to keep in step rather than a branch per type in three places.
  public static readonly TTL_SETTINGS: Array<{
    setting: SystemSettingName;
    type: ChatLobbyType;
    fallback: number;
  }> = [
    {
      setting: SystemSettingName.ChatTtlMatch,
      type: ChatLobbyType.Match,
      fallback: 60 * 60,
    },
    {
      setting: SystemSettingName.ChatTtlMatchTeam,
      type: ChatLobbyType.MatchTeam,
      fallback: 60 * 60,
    },
    {
      setting: SystemSettingName.ChatTtlMatchMaking,
      type: ChatLobbyType.MatchMaking,
      fallback: 60 * 60,
    },
    {
      setting: SystemSettingName.ChatTtlDraft,
      type: ChatLobbyType.Draft,
      fallback: 60 * 60,
    },
    {
      setting: SystemSettingName.ChatTtlTournament,
      type: ChatLobbyType.Tournament,
      fallback: 60 * 60 * 24,
    },
    {
      setting: SystemSettingName.ChatTtlOrganizers,
      type: ChatLobbyType.Organizer,
      fallback: 60 * 60 * 24,
    },
  ];

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly hasuraService: HasuraService,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
    private readonly notifications: NotificationsService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public updateChatMessageTTL(type: ChatLobbyType, expiresIn: number) {
    this.ttls.set(type, expiresIn);
  }

  private ttlFor(type: ChatLobbyType): number {
    return this.ttls.get(type) ?? ChatService.DEFAULT_TTL;
  }

  public async joinMatchLobby(
    client: FiveStackWebSocketClient,
    type: ChatLobbyType,
    id: string,
  ) {
    const user = await this.refreshClientUser(client);
    if (!user) {
      return;
    }

    if (!(await this.canAccessLobby(type, id, user))) {
      return;
    }

    const userData = await this.addUserToLobby(type, id, user, false);

    const [added, count] = await this.addSession(
      type,
      id,
      user.steam_id,
      client.id,
    );

    if (added === 1 && count === 1) {
      void this.to(type, id, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
    }

    const allUsers = await this.getAllUsersInLobby(type, id);

    client.send(
      JSON.stringify({
        event: `lobby:${type}:${id}:list`,
        data: {
          lobby: allUsers.map(({ user, inGame }) => ({
            inGame,
            ...user,
          })),
        },
      }),
    );

    client.send(
      JSON.stringify({
        event: `lobby:${type}:${id}:messages`,
        data: {
          id,
          messages: await this.getMessages(type, id),
        },
      }),
    );

    client.on("close", () => {
      void this.removeFromLobby(type, id, client);
    });
  }

  // Who is allowed in a room at all.
  //
  // Its own method because joining is no longer the only way in: marking a
  // thread read writes a row keyed on the room, and gating that on anything
  // looser would let a client stamp read state for lobbies it was never part
  // of -- one arbitrary row per call, unbounded.
  private async canAccessLobby(
    type: ChatLobbyType,
    id: string,
    user: User,
  ): Promise<boolean> {
    switch (type) {
      case ChatLobbyType.Match:
        const { matches_by_pk } = await this.hasuraService.query(
          {
            matches_by_pk: {
              __args: {
                id,
              },
              is_coach: true,
              is_organizer: true,
              is_in_lineup: true,
            },
          },
          user.steam_id,
        );

        if (!matches_by_pk) {
          return false;
        }

        if (
          matches_by_pk.is_coach === false &&
          matches_by_pk.is_in_lineup === false &&
          matches_by_pk.is_organizer === false
        ) {
          return false;
        }

        break;
      case ChatLobbyType.MatchTeam: {
        const [matchId, lineupId] = id.split(":");

        if (!matchId || !lineupId) {
          return false;
        }

        const { match_lineups_by_pk } = await this.hasuraService.query(
          {
            match_lineups_by_pk: {
              __args: {
                id: lineupId,
              },
              match_id: true,
              coach_steam_id: true,
              is_on_lineup: true,
            },
          },
          user.steam_id,
        );

        // The lineup has to actually be one side of this match, otherwise the
        // room key could be pointed at any lineup in the system.
        if (!match_lineups_by_pk || match_lineups_by_pk.match_id !== matchId) {
          return false;
        }

        if (
          match_lineups_by_pk.is_on_lineup === false &&
          match_lineups_by_pk.coach_steam_id !== user.steam_id
        ) {
          return false;
        }

        break;
      }
      case ChatLobbyType.MatchMaking:
        const { lobby_players_by_pk } = await this.hasuraService.query({
          lobby_players_by_pk: {
            __args: {
              lobby_id: id,
              steam_id: user.steam_id,
            },
            status: true,
          },
        });

        if (lobby_players_by_pk?.status !== "Accepted") {
          return false;
        }

        break;
      case ChatLobbyType.Tournament:
        const { tournaments } = await this.hasuraService.query(
          {
            tournaments: {
              __args: {
                where: {
                  id: {
                    _eq: id,
                  },
                  _or: [
                    {
                      is_organizer: {
                        _eq: true,
                      },
                    },
                    {
                      teams: {
                        _or: [
                          {
                            owner_steam_id: {
                              _eq: user.steam_id,
                            },
                          },
                          {
                            roster: {
                              player_steam_id: {
                                _eq: user.steam_id,
                              },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              id: true,
            },
          },
          user.steam_id,
        );

        if (tournaments.length === 0) {
          return false;
        }
        break;
      case ChatLobbyType.Draft: {
        if (isRoleAbove(user.role, "match_organizer")) {
          break;
        }

        const { draft_games } = await this.hasuraService.query({
          draft_games: {
            __args: {
              where: {
                id: { _eq: id },
                _or: [
                  { access: { _eq: "Open" } },
                  { host_steam_id: { _eq: user.steam_id } },
                  { players: { steam_id: { _eq: user.steam_id } } },
                ],
              },
            },
            id: true,
          },
        });

        if (draft_games.length === 0) {
          return false;
        }

        break;
      }
      case ChatLobbyType.Organizer:
        if (!isRoleAbove(user.role, "match_organizer")) {
          return false;
        }

        break;
      case ChatLobbyType.Direct: {
        const parties = parseDirectRoomId(id);

        if (!parties || !parties.includes(String(user.steam_id))) {
          return false;
        }

        // Being one of the two parties is not on its own an authorization:
        // anyone can build the id for any pair of steam ids, since it is just
        // their sorted pair. The friendship is the only thing standing between
        // this and unsolicited messages from strangers.
        //
        // No administrator bypass, unlike Draft/Organizer above -- those are
        // group rooms an organizer runs, this is a private conversation.
        const otherSteamId = parties.find(
          (party) => party !== String(user.steam_id),
        );

        const { friends } = await this.hasuraService.query({
          friends: {
            __args: {
              where: {
                status: { _eq: "Accepted" },
                _or: [
                  {
                    player_steam_id: { _eq: user.steam_id },
                    other_player_steam_id: { _eq: otherSteamId },
                  },
                  {
                    player_steam_id: { _eq: otherSteamId },
                    other_player_steam_id: { _eq: user.steam_id },
                  },
                ],
              },
              limit: 1,
            },
            status: true,
          },
        });

        if (friends.length === 0) {
          return false;
        }

        break;
      }
      default:
        this.logger.warn(`Unknown lobby type: ${type}`);
        return false;
    }

    return true;
  }

  // A room's history, from whichever store holds it. DMs are durable and live
  // in postgres; every other room is redis behind its own TTL.
  private async getMessages(type: ChatLobbyType, id: string) {
    if (type === ChatLobbyType.Direct) {
      return await this.getDirectMessages(id);
    }

    const messagesObject = await this.redis.hgetall(`chat_${type}_${id}`);

    return Object.values(messagesObject)
      .map((value) => JSON.parse(value))
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
  }

  private async refreshClientUser(client: FiveStackWebSocketClient) {
    if (!client.user?.steam_id) {
      return;
    }

    const currentUser = await this.getCurrentUser(client.user.steam_id);
    if (!currentUser) {
      return;
    }

    client.user = {
      ...client.user,
      ...currentUser,
    };

    return client.user;
  }

  private async getCurrentUser(steamId: string): Promise<User | undefined> {
    const { players_by_pk } = await this.hasuraService.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        name: true,
        role: true,
        steam_id: true,
        country: true,
        profile_url: true,
        avatar_url: true,
        discord_id: true,
        language: true,
        last_sign_in_at: true,
      },
    });

    if (!players_by_pk) {
      return;
    }

    return {
      ...players_by_pk,
      steam_id: String(players_by_pk.steam_id),
    } as User;
  }

  private async canSendDraftMessage(
    id: string,
    player: User,
  ): Promise<boolean> {
    if (isRoleAbove(player.role, "match_organizer")) {
      return true;
    }

    const steamId = player.steam_id;

    const { draft_games_by_pk } = await this.hasuraService.query({
      draft_games_by_pk: {
        __args: { id },
        status: true,
        match_id: true,
        host_steam_id: true,
        players: {
          steam_id: true,
          status: true,
          lineup: true,
        },
      },
    });

    if (!draft_games_by_pk) {
      return false;
    }

    const lobbyPhase =
      !draft_games_by_pk.match_id &&
      ["Open", "Filled"].includes(draft_games_by_pk.status);

    if (lobbyPhase) {
      return true;
    }

    if (String(draft_games_by_pk.host_steam_id) === String(steamId)) {
      return true;
    }

    // A waitlisted backup moved into a lineup plays in the match but keeps
    // their Waitlist status, so lineup membership counts too.
    return (draft_games_by_pk.players || []).some(
      (draftPlayer) =>
        String(draftPlayer.steam_id) === String(steamId) &&
        (draftPlayer.status === "Accepted" || draftPlayer.lineup != null),
    );
  }

  public async sendMessageToChat(
    type: ChatLobbyType,
    id: string,
    player: User,
    _message: string,
    skipCheck = false,
  ) {
    // verify they are in the lobby
    if (skipCheck === false) {
      const userData = await this.getUserData(type, id, player.steam_id);
      if (!userData) {
        return;
      }

      if (
        type === ChatLobbyType.Draft &&
        !(await this.canSendDraftMessage(id, player))
      ) {
        return;
      }
    }

    const name = await this.redis.get(
      HasuraService.PLAYER_NAME_CACHE_KEY(player.steam_id),
    );

    const role: e_player_roles_enum = (await this.redis.get(
      HasuraService.PLAYER_ROLE_CACHE_KEY(player.steam_id),
    )) as unknown as e_player_roles_enum;

    const timestamp = new Date();
    const message = {
      // Both the history snapshot sent on join and the live broadcast carry the
      // message, so clients need something stable to recognize it by.
      id: randomUUID(),
      message: _message,
      timestamp: timestamp.toISOString(),
      from: {
        role: name ? JSON.parse(role) : player.role,
        name: name ? JSON.parse(name) : player.name,
        steam_id: player.steam_id,
        avatar_url: player.avatar_url,
        profile_url: player.profile_url,
      },
    };

    if (type === ChatLobbyType.Direct) {
      await this.storeDirectMessage(id, message);
    } else {
      const messageKey = `chat_${type}_${id}`;
      // Keyed by id and not `${steam_id}:${now}`, which silently dropped a
      // message when the same player landed two within the same millisecond.
      const messageField = message.id;
      await this.redis.hset(messageKey, messageField, JSON.stringify(message));

      await this.redis.sendCommand(
        new Redis.Command("HEXPIRE", [
          messageKey,
          this.ttlFor(type),
          "FIELDS",
          1,
          messageField,
        ]),
      );
    }

    void this.to(type, id, "chat", message);

    if (type === ChatLobbyType.Direct) {
      void this.deliverDirectMessage(id, player, message);
    }

    // Best effort, and never allowed to take a message delivery down with it.
    void this.notifyLobbyMembers(
      type,
      id,
      player,
      message.from.name,
      _message,
    ).catch(
      (error) => {
        this.logger.warn(`unable to notify ${type}:${id} of a message`, error);
      },
    );
  }

  // Notifies the whole roster and lets the delivery gate decide who actually
  // hears about it.
  //
  // This deliberately does not filter on room presence. That hash tracks
  // whether a client holds an open socket to the room, which is tied to the
  // chat widget's mount lifecycle rather than to anyone reading it -- on a
  // match page the connection outlives the panel being open, so filtering on it
  // silenced the notification for exactly the audience it exists for.
  //
  // What replaced it is a signal that means what it says: the client reports
  // the thread it is showing while visible, and the recipient's read cursor
  // says how far they have got. Both are checked at send time rather than here,
  // because between an insert and a push is precisely when someone opens the
  // conversation. See notifications/push/push-notifications.service.ts.
  private async notifyLobbyMembers(
    type: ChatLobbyType,
    id: string,
    sender: User,
    senderName: string,
    message: string,
  ) {
    const members = await this.getLobbyMemberSteamIds(type, id);
    const senderSteamId = String(sender.steam_id);

    const targets = members.filter((steamId) => steamId !== senderSteamId);

    if (targets.length === 0) {
      return;
    }

    const entityId = `${type}:${id}`;
    const notificationType = ChatService.notificationTypeFor(type);

    await this.notifications.notifyPlayers(notificationType, {
      title: senderName,
      message: NotificationsService.escapeHtml(
        message.length > 140 ? `${message.slice(0, 140)}…` : message,
      ),
      role: "user",
      entity_id: entityId,
      steamIds: targets,
      data: {
        threadKey: chatThreadKey(type, id),
        threadLabel: await this.threadLabel(type, id, sender),
        icon: sender.avatar_url,
        senderSteamId,
      },
    });

    // Collapse to one unread bell row per conversation, and only after the
    // insert above. Editing an existing row instead would produce no INSERT,
    // and the INSERT is what the push event trigger fires on -- so the bell
    // would be tidy and the phone would stay silent.
    await this.notifications.collapseOlderUnread(
      notificationType,
      entityId,
      targets,
    );
  }

  // Match chat is its own notification type, and so its own push category.
  //
  // Every line typed in-game is relayed into the match room by
  // ChatMessageEvent, so a live match fires this per lineup member per line --
  // and the player it reaches is the one already reading those lines in the
  // game. Sharing a category with direct messages meant the only way to stop
  // that was to mute DMs too.
  //
  // The insert, the bell collapse and the read-clear all have to agree on the
  // type or the collapse stops collapsing and the badge never clears.
  public static notificationTypeFor(
    type: ChatLobbyType,
  ): e_notification_types_enum {
    return type === ChatLobbyType.Match ? "MatchChatMessage" : "ChatMessage";
  }

  // What to call this room when a push has to name it -- "3 new messages from
  // Luke and Ratz" needs somewhere to put "Ancients vs Ratz".
  //
  // Cached, because it is otherwise a Hasura round trip per message for a
  // string that changes about never. A DM is labelled by its sender rather than
  // its room: the peer differs per recipient, and a bundle of DMs only ever has
  // one sender anyway, so the label is never the thing shown.
  private async threadLabel(
    type: ChatLobbyType,
    id: string,
    sender: User,
  ): Promise<string> {
    if (type === ChatLobbyType.Direct) {
      return sender.name;
    }

    const cacheKey = `chat:label:${type}:${id}`;
    const cached = await this.redis.get(cacheKey);

    if (cached !== null) {
      return cached;
    }

    const label = await this.resolveThreadLabel(type, id);

    await this.redis.set(cacheKey, label, "EX", 60 * 30);

    return label;
  }

  private async resolveThreadLabel(
    type: ChatLobbyType,
    id: string,
  ): Promise<string> {
    switch (type) {
      case ChatLobbyType.Match:
      case ChatLobbyType.MatchTeam: {
        const matchId = type === ChatLobbyType.Match ? id : id.split(":").at(0);

        const { matches_by_pk } = await this.hasuraService.query({
          matches_by_pk: {
            __args: { id: matchId },
            lineup_1: { name: true },
            lineup_2: { name: true },
          },
        });

        const teams = [
          matches_by_pk?.lineup_1?.name,
          matches_by_pk?.lineup_2?.name,
        ].filter(Boolean);

        const match = teams.length === 2 ? teams.join(" vs ") : "Match";

        return type === ChatLobbyType.MatchTeam ? `${match} (team)` : match;
      }
      case ChatLobbyType.Tournament: {
        const { tournaments_by_pk } = await this.hasuraService.query({
          tournaments_by_pk: {
            __args: { id },
            name: true,
          },
        });

        return tournaments_by_pk?.name ?? "Tournament";
      }
      case ChatLobbyType.Draft: {
        // Draft lobbies have no name of their own, so the host is what
        // distinguishes one from another.
        const { draft_games_by_pk } = await this.hasuraService.query({
          draft_games_by_pk: {
            __args: { id },
            host: { name: true },
          },
        });

        const host = draft_games_by_pk?.host?.name;

        return host ? `${host}'s Draft` : "Draft Lobby";
      }
      case ChatLobbyType.MatchMaking:
        return "Matchmaking Lobby";
      case ChatLobbyType.Organizer:
        return "Organizers";
      default:
        return "Chat";
    }
  }

  // The fixed roster of a lobby, as opposed to getAllUsersInLobby's "who is
  // connected right now".
  //
  // Mirrors joinMatchLobby's authorization switch above -- that switch is the
  // definition of who belongs in a room, so the two have to move together.
  public async getLobbyMemberSteamIds(
    type: ChatLobbyType,
    id: string,
  ): Promise<string[]> {
    const steamIds = new Set<string>();
    const add = (value: unknown) => {
      if (value !== null && value !== undefined) {
        steamIds.add(String(value));
      }
    };

    switch (type) {
      case ChatLobbyType.Match: {
        const { matches_by_pk } = await this.hasuraService.query({
          matches_by_pk: {
            __args: { id },
            organizer_steam_id: true,
            lineup_1: {
              coach_steam_id: true,
              lineup_players: { steam_id: true },
            },
            lineup_2: {
              coach_steam_id: true,
              lineup_players: { steam_id: true },
            },
          },
        });

        if (!matches_by_pk) {
          break;
        }

        add(matches_by_pk.organizer_steam_id);

        for (const lineup of [matches_by_pk.lineup_1, matches_by_pk.lineup_2]) {
          add(lineup?.coach_steam_id);
          for (const lineupPlayer of lineup?.lineup_players ?? []) {
            add(lineupPlayer.steam_id);
          }
        }

        break;
      }
      case ChatLobbyType.MatchTeam: {
        const [, lineupId] = id.split(":");

        if (!lineupId) {
          break;
        }

        const { match_lineups_by_pk } = await this.hasuraService.query({
          match_lineups_by_pk: {
            __args: { id: lineupId },
            coach_steam_id: true,
            lineup_players: { steam_id: true },
          },
        });

        add(match_lineups_by_pk?.coach_steam_id);

        for (const lineupPlayer of match_lineups_by_pk?.lineup_players ?? []) {
          add(lineupPlayer.steam_id);
        }

        break;
      }
      case ChatLobbyType.MatchMaking: {
        const { lobby_players } = await this.hasuraService.query({
          lobby_players: {
            __args: {
              where: {
                lobby_id: { _eq: id },
                status: { _eq: "Accepted" },
              },
            },
            steam_id: true,
          },
        });

        for (const lobbyPlayer of lobby_players ?? []) {
          add(lobbyPlayer.steam_id);
        }

        break;
      }
      case ChatLobbyType.Tournament: {
        const { tournaments_by_pk } = await this.hasuraService.query({
          tournaments_by_pk: {
            __args: { id },
            organizer_steam_id: true,
            organizers: { steam_id: true },
            teams: {
              owner_steam_id: true,
              roster: { player_steam_id: true },
            },
          },
        });

        add(tournaments_by_pk?.organizer_steam_id);

        for (const organizer of tournaments_by_pk?.organizers ?? []) {
          add(organizer.steam_id);
        }

        for (const team of tournaments_by_pk?.teams ?? []) {
          add(team.owner_steam_id);
          for (const roster of team.roster ?? []) {
            add(roster.player_steam_id);
          }
        }

        break;
      }
      case ChatLobbyType.Draft: {
        const { draft_games_by_pk } = await this.hasuraService.query({
          draft_games_by_pk: {
            __args: { id },
            host_steam_id: true,
            players: {
              steam_id: true,
              status: true,
              lineup: true,
            },
          },
        });

        add(draft_games_by_pk?.host_steam_id);

        // Same predicate as canSendDraftMessage: a waitlisted backup seated in
        // a lineup is playing, whatever their status still says.
        for (const draftPlayer of draft_games_by_pk?.players ?? []) {
          if (draftPlayer.status === "Accepted" || draftPlayer.lineup != null) {
            add(draftPlayer.steam_id);
          }
        }

        break;
      }
      case ChatLobbyType.Direct: {
        for (const party of parseDirectRoomId(id) ?? []) {
          add(party);
        }

        break;
      }
      case ChatLobbyType.Organizer: {
        // The one room with no roster to read: membership is the role gate in
        // joinMatchLobby above, so it has to be resolved from the players
        // table instead. Left to the default branch this returned nobody, and
        // notifyLobbyMembers bailed on the empty list -- the organizers' room
        // has never notified anyone in it.
        //
        // Not narrowed to recently active staff. The list is small, and
        // notifyPlayers already drops anyone with neither the bell nor a
        // subscription to deliver to.
        const { players } = await this.hasuraService.query({
          players: {
            __args: {
              where: {
                role: { _in: rolesAtOrAbove("match_organizer") },
              },
            },
            steam_id: true,
          },
        });

        for (const player of players ?? []) {
          add(player.steam_id);
        }

        break;
      }
      default:
        // Nothing ever opens a Team room, so it has nobody to notify.
        break;
    }

    return [...steamIds];
  }

  // `to()` only reaches steam ids currently sitting in the lobby hash, and the
  // other side of a DM usually isn't -- they have no tab open for a
  // conversation they don't know exists yet. So the recipient is addressed
  // directly, which is what makes a first-contact message arrive at all.
  private async deliverDirectMessage(
    id: string,
    sender: User,
    message: Record<string, any>,
  ) {
    const parties = parseDirectRoomId(id);

    if (!parties) {
      return;
    }

    for (const steamId of parties) {
      if (steamId === String(sender.steam_id)) {
        continue;
      }

      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId,
          event: "direct:incoming",
          data: {
            roomId: id,
            from: message.from,
            message,
          },
        }),
      );
    }
  }

  // A direct message is a conversation, not lobby chatter. Redis held these
  // behind a TTL, which meant a flush took everyone's history with it and a
  // year of them would have to sit in memory to avoid that.
  //
  // The conversation rows are what make listing a player's DMs one indexed read
  // -- room_id encodes both participants, but "every room containing me" out of
  // that is an unanchored LIKE.
  // Stamped by postgres, not by the sender's `timestamp`.
  //
  // The read cursor is written with now(), so a message carrying the API pod's
  // clock is being compared against the database's. A pod running even
  // milliseconds ahead leaves a just-read message looking unread -- forever,
  // and pushing every time. The websocket broadcast keeps the pod's timestamp;
  // clients dedupe on the message id, not on when it claims to have happened.
  private async storeDirectMessage(
    roomId: string,
    message: { id: string; message: string; from: User },
  ) {
    const parties = parseDirectRoomId(roomId);

    if (!parties) {
      return;
    }

    await this.postgres.query(
      `INSERT INTO public.direct_messages (id, room_id, from_steam_id, message)
            VALUES ($1::uuid, $2, $3::bigint, $4)`,
      [message.id, roomId, message.from.steam_id, message.message],
    );

    // A message puts the conversation back on the bar, even if it was removed
    // from it -- someone writing to you is exactly when you want to see them
    // again. It only jumps to the top when it was off the bar; a conversation
    // already sitting where the player put it stays there.
    await this.postgres.query(
      `INSERT INTO public.direct_conversations
              (room_id, steam_id, last_message_at, is_open, position)
            SELECT $1, party.steam_id, now(), true,
                   COALESCE((SELECT min(existing.position) - 1
                               FROM public.direct_conversations existing
                              WHERE existing.steam_id = party.steam_id), 0)
              FROM unnest($2::bigint[]) AS party(steam_id)
       ON CONFLICT (room_id, steam_id) DO UPDATE
               SET last_message_at = EXCLUDED.last_message_at,
                   is_open = true,
                   position = CASE
                     WHEN public.direct_conversations.is_open
                       THEN public.direct_conversations.position
                     ELSE EXCLUDED.position
                   END`,
      [roomId, parties],
    );

    await this.enforceDirectBarLimit(parties);
  }

  // How many conversations the rail holds. Past this the quietest one drops
  // off -- it still exists, and comes back the moment that person writes.
  private static readonly MAX_DIRECT_TABS = 8;

  // Enforced here rather than in the client so every device shows the same bar.
  private async enforceDirectBarLimit(steamIds: string[]) {
    await this.postgres.query(
      `WITH ranked AS (
         SELECT room_id, steam_id,
                row_number() OVER (
                  PARTITION BY steam_id
                  ORDER BY last_message_at DESC
                ) AS rank
           FROM public.direct_conversations
          WHERE steam_id = ANY($1::bigint[])
            AND is_open = true
       )
       UPDATE public.direct_conversations dc
          SET is_open = false
         FROM ranked
        WHERE ranked.room_id = dc.room_id
          AND ranked.steam_id = dc.steam_id
          AND ranked.rank > $2::int`,
      [steamIds, ChatService.MAX_DIRECT_TABS],
    );
  }

  // Whether a conversation sits on the player's rail. Removing it is a local
  // preference and says nothing to the other party.
  public async setConversationOpen(
    roomId: string,
    user: User,
    open: boolean,
  ): Promise<void> {
    const parties = parseDirectRoomId(roomId);

    if (!parties || !parties.includes(String(user.steam_id))) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.direct_conversations
          SET is_open = $3,
              position = CASE
                WHEN $3 THEN COALESCE(
                  (SELECT min(existing.position) - 1
                     FROM public.direct_conversations existing
                    WHERE existing.steam_id = $2::bigint), 0)
                ELSE position
              END
        WHERE room_id = $1 AND steam_id = $2::bigint`,
      [roomId, user.steam_id, open],
    );

    if (open) {
      await this.enforceDirectBarLimit([String(user.steam_id)]);
    }
  }

  // The order the player dragged the rail into, written whole.
  //
  // Positions are rewritten from the given order rather than nudged, so they
  // stay dense and there is never a rebalance to do. Rooms the player is not a
  // party to simply do not match.
  public async reorderConversations(
    roomIds: string[],
    user: User,
  ): Promise<void> {
    const owned = roomIds.filter((roomId) => {
      const parties = parseDirectRoomId(roomId);
      return parties?.includes(String(user.steam_id));
    });

    if (owned.length === 0) {
      return;
    }

    await this.postgres.query(
      `UPDATE public.direct_conversations dc
          SET position = ordered.position
         FROM unnest($1::text[]) WITH ORDINALITY AS ordered(room_id, position)
        WHERE dc.room_id = ordered.room_id
          AND dc.steam_id = $2::bigint`,
      [owned, user.steam_id],
    );
  }

  private async getDirectMessages(roomId: string) {
    const rows = await this.postgres.query<
      Array<{
        id: string;
        message: string;
        created_at: Date;
        steam_id: string;
        name: string;
        role: e_player_roles_enum;
        avatar_url: string | null;
        profile_url: string | null;
      }>
    >(
      `SELECT dm.id::text AS id, dm.message, dm.created_at,
              p.steam_id::text AS steam_id, p.name, p.role::text AS role,
              p.avatar_url, p.profile_url
         FROM public.direct_messages dm
         JOIN public.players p ON p.steam_id = dm.from_steam_id
        WHERE dm.room_id = $1
        ORDER BY dm.created_at DESC, dm.seq DESC
        LIMIT 200`,
      [roomId],
    );

    return rows.reverse().map((row) => ({
      id: row.id,
      message: row.message,
      timestamp: new Date(row.created_at).toISOString(),
      from: {
        role: row.role,
        name: row.name,
        steam_id: row.steam_id,
        avatar_url: row.avatar_url,
        profile_url: row.profile_url,
      },
    }));
  }

  // Server-side read state, so unread counts survive a reload instead of
  // living only in the tab bar's memory.
  //
  // Every lobby type, not just DMs. A cursor is what lets the push gate know a
  // message has been seen, and a match lobby is exactly where someone is most
  // likely to be reading along already.
  //
  // In postgres rather than redis: a flush would reset every cursor on the
  // platform at once, and the next message in every thread would then look
  // unread and push.
  // Gated on the same answer as joining the room. `type` and `id` are whatever
  // the socket sent, and without this a client can write a row per call for any
  // id it can invent -- and mark read state for lobbies it was never in.
  //
  // Answers with the cursor postgres wrote, so the client can replace the one
  // it stamped from its own clock.
  public async markThreadRead(
    type: ChatLobbyType,
    id: string,
    user: User,
  ): Promise<{ thread: string; lastReadAt: string } | null> {
    if (!(await this.canAccessLobby(type, id, user))) {
      return null;
    }

    const thread = chatThreadKey(type, id);

    const [row] = await this.postgres.query<Array<{ last_read_at: Date }>>(
      `INSERT INTO public.chat_read_state (steam_id, thread, last_read_at)
            VALUES ($1::bigint, $2, now())
       ON CONFLICT (steam_id, thread) DO UPDATE SET last_read_at = now()
         RETURNING last_read_at`,
      [user.steam_id, thread],
    );

    await this.notifications.markConversationRead(
      ChatService.notificationTypeFor(type),
      `${type}:${id}`,
      user.steam_id,
    );

    if (!row) {
      return null;
    }

    return {
      thread,
      lastReadAt: new Date(row.last_read_at).toISOString(),
    };
  }

  // Every conversation a player has, newest first, with the unread count each
  // one carries.
  public async getDirectConversations(user: User) {
    const rows = await this.postgres.query<
      Array<{
        room_id: string;
        last_message_at: Date;
        is_open: boolean;
        position: number;
        unread: string;
        peer_steam_id: string | null;
        peer_name: string | null;
        peer_avatar_url: string | null;
        peer_profile_url: string | null;
      }>
    >(
      `SELECT dc.room_id,
              dc.last_message_at,
              dc.is_open,
              dc.position,
              (SELECT count(*)
                 FROM public.direct_messages dm
                WHERE dm.room_id = dc.room_id
                  AND dm.from_steam_id <> dc.steam_id
                  AND (crs.last_read_at IS NULL
                       OR dm.created_at > crs.last_read_at))::text AS unread,
              peer.steam_id::text AS peer_steam_id,
              peer.name AS peer_name,
              peer.avatar_url AS peer_avatar_url,
              peer.profile_url AS peer_profile_url
         FROM public.direct_conversations dc
    LEFT JOIN public.chat_read_state crs
           ON crs.steam_id = dc.steam_id
          AND crs.thread = 'chat:direct:' || dc.room_id
    -- The other participant, found through the room they share rather than by
    -- picking the id string apart.
    LEFT JOIN public.direct_conversations other
           ON other.room_id = dc.room_id
          AND other.steam_id <> dc.steam_id
    LEFT JOIN public.players peer ON peer.steam_id = other.steam_id
        WHERE dc.steam_id = $1::bigint
        -- The rail's own order. last_message_at only breaks ties between rows
        -- that have never been arranged relative to each other.
        ORDER BY dc.position ASC, dc.last_message_at DESC
        LIMIT 100`,
      [user.steam_id],
    );

    return rows.map((row) => ({
      roomId: row.room_id,
      isOpen: row.is_open,
      position: row.position,
      unread: Number(row.unread ?? 0),
      peer: {
        // The join finds nobody when the counterpart's own row is missing --
        // a deleted player takes theirs with it and leaves yours behind. The
        // id is still in the room id, and without it the tab renders as the
        // raw `steamid:steamid` pair with nobody to message.
        steam_id:
          row.peer_steam_id ??
          parseDirectRoomId(row.room_id)?.find(
            (party) => party !== String(user.steam_id),
          ) ??
          null,
        name: row.peer_name,
        avatar_url: row.peer_avatar_url,
        profile_url: row.peer_profile_url,
      },
      lastMessageAt: new Date(row.last_message_at).toISOString(),
    }));
  }

  // Where this player has read up to in each thread.
  //
  // Cursors rather than counts, deliberately. The client is handed a room's
  // whole history when it joins, so it can count what is newer than the cursor
  // itself -- and counting server side would mean either reaching into every
  // lobby's redis hash on page load, or reading the bell, where
  // collapseOlderUnread has already reduced each conversation to one row.
  public async getReadState(user: User) {
    const rows = await this.postgres.query<
      Array<{ thread: string; last_read_at: Date }>
    >(
      `SELECT thread, last_read_at
         FROM public.chat_read_state
        WHERE steam_id = $1::bigint`,
      [user.steam_id],
    );

    return rows.map((row) => ({
      thread: row.thread,
      lastReadAt: new Date(row.last_read_at).toISOString(),
    }));
  }

  public async to(
    type: ChatLobbyType,
    id: string,
    event: "chat" | "list" | "messages" | "joined" | "left",
    data: Record<string, any>,
  ) {
    const users = await this.getAllUsersInLobby(type, id);
    const eventName = `lobby:${type}:${id}:${event}`;

    for (const { steamId } of users) {
      await this.redis.publish(
        "send-message-to-steam-id",
        JSON.stringify({
          steamId,
          event: eventName,
          data,
        }),
      );
    }
  }

  public async removeFromLobby(
    type: ChatLobbyType,
    id: string,
    client: FiveStackWebSocketClient,
  ) {
    const userData = await this.getUserData(type, id, client.user.steam_id);
    if (!userData) {
      return;
    }

    const [removed, count] = await this.removeSession(
      type,
      id,
      client.user.steam_id,
      client.id,
    );

    if (removed === 1 && count === 0) {
      await this.removeUserData(type, id, client.user.steam_id);
      void this.to(type, id, "left", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
      return;
    }

    if (removed === 1 && userData.inGame) {
      void this.to(type, id, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
    }
  }

  public async sendChatToServer(matchId: string, message: string) {
    try {
      const { matches_by_pk } = await this.hasuraService.query({
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          status: true,
          server: {
            id: true,
            plugin_runtime: true,
          },
        },
      });

      const server = matches_by_pk?.server;

      if (!server) {
        return;
      }

      if (matches_by_pk.status !== "Live") {
        return;
      }

      const rcon = await this.rcon.connect(server.id);
      if (!rcon) {
        return;
      }

      const command =
        server.plugin_runtime === "counterstrikesharp"
          ? "css_web_chat"
          : "sw_web_chat";

      return await rcon.send(`${command} "${message}"`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send match to server`,
        error.message,
      );
    }
  }

  public async joinLobbyViaGame(matchId: string, steamId: string) {
    const { players_by_pk: player } = await this.hasuraService.query({
      players_by_pk: {
        __args: {
          steam_id: steamId,
        },
        name: true,
        role: true,
        steam_id: true,
        avatar_url: true,
        discord_id: true,
      },
    });

    const userData = await this.addUserToLobby(
      ChatLobbyType.Match,
      matchId,
      player,
      true,
    );

    void this.to(ChatLobbyType.Match, matchId, "joined", {
      user: {
        ...userData.user,
        inGame: userData.inGame,
      },
    });
  }

  public async leaveLobbyViaGame(matchId: string, steamId: string) {
    const userData = await this.getUserData(
      ChatLobbyType.Match,
      matchId,
      steamId,
    );
    if (!userData) {
      return;
    }

    userData.inGame = false;
    await this.setUserData(ChatLobbyType.Match, matchId, steamId, userData);

    const sessionCount = await this.redis.scard(
      this.sessionsKey(ChatLobbyType.Match, matchId, steamId),
    );
    if (sessionCount > 0) {
      void this.to(ChatLobbyType.Match, matchId, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
      return;
    }

    await this.removeUserData(ChatLobbyType.Match, matchId, steamId);

    void this.to(ChatLobbyType.Match, matchId, "left", {
      user: {
        steam_id: steamId,
      },
    });
  }

  private async addUserToLobby(
    type: ChatLobbyType,
    id: string,
    user: User,
    game: boolean,
  ) {
    let userData = await this.getUserData(type, id, user.steam_id);

    if (!userData) {
      userData = {
        user,
      };
    }

    if (game) {
      userData.inGame = true;
    }

    await this.setUserData(type, id, user.steam_id, userData);

    return userData;
  }

  private getLobbyKey(type: ChatLobbyType, id: string): string {
    return `chat:${type}:${id}`;
  }

  private sessionsKey(
    type: ChatLobbyType,
    id: string,
    steamId: string,
  ): string {
    return `${this.getLobbyKey(type, id)}:sessions:${steamId}`;
  }

  private async addSession(
    type: ChatLobbyType,
    id: string,
    steamId: string,
    clientId: string,
  ): Promise<[number, number]> {
    const result = (await this.redis.eval(
      `local added = redis.call('SADD', KEYS[1], ARGV[1])
       redis.call('EXPIRE', KEYS[1], ARGV[2])
       return {added, redis.call('SCARD', KEYS[1])}`,
      1,
      this.sessionsKey(type, id, steamId),
      clientId,
      60 * 60 * 24,
    )) as [number, number];
    return result;
  }

  private async removeSession(
    type: ChatLobbyType,
    id: string,
    steamId: string,
    clientId: string,
  ): Promise<[number, number]> {
    const result = (await this.redis.eval(
      `local removed = redis.call('SREM', KEYS[1], ARGV[1])
       return {removed, redis.call('SCARD', KEYS[1])}`,
      1,
      this.sessionsKey(type, id, steamId),
      clientId,
    )) as [number, number];
    return result;
  }

  private async getUserData(type: ChatLobbyType, id: string, steamId: string) {
    const lobbyKey = this.getLobbyKey(type, id);
    const userData = await this.redis.hget(lobbyKey, steamId);
    return userData ? JSON.parse(userData) : null;
  }

  private async setUserData(
    type: ChatLobbyType,
    id: string,
    steamId: string,
    data: any,
  ) {
    const lobbyKey = this.getLobbyKey(type, id);
    await this.redis.hset(lobbyKey, steamId, JSON.stringify(data));
    await this.redis.expire(lobbyKey, 60 * 60 * 24);
  }

  private async removeUserData(
    type: ChatLobbyType,
    id: string,
    steamId: string,
  ) {
    const lobbyKey = this.getLobbyKey(type, id);
    await this.redis.hdel(lobbyKey, steamId);
  }

  private async getAllUsersInLobby(type: ChatLobbyType, id: string) {
    const lobbyKey = this.getLobbyKey(type, id);
    const users = await this.redis.hgetall(lobbyKey);
    return Object.entries(users).map(([steamId, data]) => ({
      steamId,
      ...JSON.parse(data),
    }));
  }

  public async removeLobby(type: ChatLobbyType, id: string) {
    const lobbyKey = this.getLobbyKey(type, id);
    const sessionKeys = await this.redis.keys(`${lobbyKey}:sessions:*`);
    await this.redis.del(lobbyKey, ...sessionKeys);
  }

  public async migrateLobbyMessages(
    fromType: ChatLobbyType,
    fromId: string,
    toType: ChatLobbyType,
    toId: string,
  ) {
    const fromKey = `chat_${fromType}_${fromId}`;
    const toKey = `chat_${toType}_${toId}`;

    const messagesObject = await this.redis.hgetall(fromKey);

    for (const [field, message] of Object.entries(messagesObject)) {
      await this.redis.hset(toKey, field, message);
      await this.redis.sendCommand(
        new Redis.Command("HEXPIRE", [
          toKey,
          this.ttlFor(toType),
          "FIELDS",
          1,
          field,
        ]),
      );
    }

    await this.redis.del(fromKey);
    await this.removeLobby(fromType, fromId);

    if (Object.keys(messagesObject).length === 0) {
      return;
    }

    const merged = await this.redis.hgetall(toKey);
    const messages = Object.values(merged)
      .map((value) => JSON.parse(value))
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

    void this.to(toType, toId, "messages", { id: toId, messages });
  }
}
