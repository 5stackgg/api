import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { HasuraService } from "../hasura/hasura.service";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { e_player_roles_enum } from "generated/schema";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { NotificationsService } from "src/notifications/notifications.service";
import { parseDirectRoomId } from "./utilities/directRoomId";
@Injectable()
export class ChatService {
  private redis: Redis;

  private expiresIn = 60 * 60 * 24;

  // A direct message is a conversation, not lobby chatter -- losing it after a
  // day would make DMs useless. Everything else keeps the shared TTL.
  private directExpiresIn = 60 * 60 * 24 * 30;

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly hasuraService: HasuraService,
    private readonly redisManager: RedisManagerService,
    private readonly notifications: NotificationsService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async updateChatMessageTTL(expiresIn: number) {
    this.expiresIn = expiresIn;
  }

  public async updateDirectChatMessageTTL(expiresIn: number) {
    this.directExpiresIn = expiresIn;
  }

  private ttlFor(type: ChatLobbyType): number {
    return type === ChatLobbyType.Direct ? this.directExpiresIn : this.expiresIn;
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
          return;
        }

        if (
          matches_by_pk.is_coach === false &&
          matches_by_pk.is_in_lineup === false &&
          matches_by_pk.is_organizer === false
        ) {
          return;
        }

        break;
      case ChatLobbyType.MatchTeam: {
        const [matchId, lineupId] = id.split(":");

        if (!matchId || !lineupId) {
          return;
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
          return;
        }

        if (
          match_lineups_by_pk.is_on_lineup === false &&
          match_lineups_by_pk.coach_steam_id !== user.steam_id
        ) {
          return;
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
          return;
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
          return;
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
          return;
        }

        break;
      }
      case ChatLobbyType.Organizer:
        if (!isRoleAbove(user.role, "match_organizer")) {
          return;
        }

        break;
      case ChatLobbyType.Direct: {
        const parties = parseDirectRoomId(id);

        if (!parties || !parties.includes(String(user.steam_id))) {
          return;
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
          return;
        }

        break;
      }
      default:
        this.logger.warn(`Unknown lobby type: ${type}`);
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

    const messagesObject = await this.redis.hgetall(`chat_${type}_${id}`);

    const messages = Object.entries(messagesObject).map(([, value]) =>
      JSON.parse(value),
    );

    client.send(
      JSON.stringify({
        event: `lobby:${type}:${id}:messages`,
        data: {
          id,
          messages: messages.sort((a, b) => {
            return (
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
          }),
        },
      }),
    );

    client.on("close", () => {
      void this.removeFromLobby(type, id, client);
    });
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

  // Deliberately does NOT skip members who are "present" in the lobby.
  //
  // The presence hash tracks whether a client holds an open socket to the room,
  // which is tied to the chat widget's mount lifecycle rather than to anyone
  // actually reading it -- on a match page the connection outlives the panel
  // being open. Filtering on it silently suppressed the notification for anyone
  // who had merely visited the page earlier, which is the whole audience it
  // exists for. An occasional redundant notification while actively chatting is
  // the cheaper mistake.
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

    await this.notifications.notifyPlayers("ChatMessage", {
      title: senderName,
      message: NotificationsService.escapeHtml(
        message.length > 140 ? `${message.slice(0, 140)}…` : message,
      ),
      role: "user",
      entity_id: entityId,
      steamIds: targets,
    });

    // Collapse to one unread bell row per conversation, and only after the
    // insert above. Editing an existing row instead would produce no INSERT,
    // and the INSERT is what the push event trigger fires on -- so the bell
    // would be tidy and the phone would stay silent.
    await this.notifications.collapseOlderUnread(
      "ChatMessage",
      entityId,
      targets,
    );
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
      default:
        // Organizer membership is role-based rather than a fixed roster, and
        // nothing ever opens a Team room. Neither has anyone to notify.
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

    const now = Date.now();

    for (const steamId of parties) {
      // Newest-conversation-first ordering, so listing someone's DMs is one
      // ZREVRANGE rather than a scan over every room they have ever opened.
      await this.redis.zadd(ChatService.DIRECT_INDEX_KEY(steamId), now, id);
      await this.redis.expire(
        ChatService.DIRECT_INDEX_KEY(steamId),
        this.directExpiresIn,
      );

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

  private static DIRECT_INDEX_KEY(steamId: string) {
    return `chat:direct:index:${steamId}`;
  }

  private static DIRECT_READ_KEY(steamId: string) {
    return `chat:direct:read:${steamId}`;
  }

  // Server-side read state, so unread counts survive a reload instead of
  // living only in the tab bar's memory.
  public async markDirectRead(id: string, user: User) {
    const parties = parseDirectRoomId(id);

    if (!parties || !parties.includes(String(user.steam_id))) {
      return;
    }

    await this.redis.hset(
      ChatService.DIRECT_READ_KEY(user.steam_id),
      id,
      new Date().toISOString(),
    );
    await this.redis.expire(
      ChatService.DIRECT_READ_KEY(user.steam_id),
      this.directExpiresIn,
    );

    await this.notifications.markConversationRead(
      "ChatMessage",
      `${ChatLobbyType.Direct}:${id}`,
      user.steam_id,
    );
  }

  // Every conversation a player has, newest first, with the unread count each
  // one carries.
  public async getDirectConversations(user: User) {
    const roomIds = await this.redis.zrevrange(
      ChatService.DIRECT_INDEX_KEY(user.steam_id),
      0,
      99,
    );

    if (roomIds.length === 0) {
      return [];
    }

    const readState = await this.redis.hgetall(
      ChatService.DIRECT_READ_KEY(user.steam_id),
    );

    const conversations = [];

    for (const roomId of roomIds) {
      const parties = parseDirectRoomId(roomId);

      if (!parties) {
        continue;
      }

      const peerSteamId = parties.find(
        (party) => party !== String(user.steam_id),
      );

      const messages = Object.values(
        await this.redis.hgetall(`chat_${ChatLobbyType.Direct}_${roomId}`),
      ).map((value) => JSON.parse(value));

      if (messages.length === 0) {
        continue;
      }

      const readAt = readState[roomId] ? new Date(readState[roomId]) : null;

      const unread = messages.filter(
        (message) =>
          String(message.from?.steam_id) !== String(user.steam_id) &&
          (!readAt || new Date(message.timestamp) > readAt),
      ).length;

      const peer = messages.find(
        (message) => String(message.from?.steam_id) === peerSteamId,
      )?.from;

      conversations.push({
        roomId,
        unread,
        peer: peer ?? { steam_id: peerSteamId },
        lastMessageAt: messages
          .map((message) => message.timestamp)
          .sort()
          .pop(),
      });
    }

    return conversations;
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
