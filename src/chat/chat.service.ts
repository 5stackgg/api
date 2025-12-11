import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { HasuraService } from "../hasura/hasura.service";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { e_player_roles_enum } from "generated/schema";

@Injectable()
export class ChatService {
  private redis: Redis;
  private sessions: Map<string, FiveStackWebSocketClient[]> = new Map();

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly hasuraService: HasuraService,
    private readonly redisManager: RedisManagerService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  public async joinMatchLobby(
    client: FiveStackWebSocketClient,
    type: ChatLobbyType,
    id: string,
  ) {
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
          client.user.steam_id,
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
      case ChatLobbyType.MatchMaking:
        const { lobby_players_by_pk } = await this.hasuraService.query({
          lobby_players_by_pk: {
            __args: {
              lobby_id: id,
              steam_id: client.user.steam_id,
            },
            status: true,
          },
        });

        if (lobby_players_by_pk?.status !== "Accepted") {
          return;
        }

        break;
      default:
        this.logger.warn(`Unknown lobby type: ${type}`);
        return;
    }

    const userData = await this.addUserToLobby(type, id, client.user, false);

    if (!this.sessions.has(client.user.steam_id)) {
      this.sessions.set(client.user.steam_id, []);
    }

    const userSessions = this.sessions.get(client.user.steam_id);

    if (userSessions.length === 0) {
      void this.to(type, id, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
    }

    if (!userSessions.includes(client)) {
      userSessions.push(client);
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
    }

    const name = await this.redis.get(
      HasuraService.PLAYER_NAME_CACHE_KEY(player.steam_id),
    );

    const role: e_player_roles_enum = (await this.redis.get(
      HasuraService.PLAYER_ROLE_CACHE_KEY(player.steam_id),
    )) as unknown as e_player_roles_enum;

    const timestamp = new Date();
    const message = {
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
    const messageField = `${player.steam_id}:${Date.now().toString()}`;
    await this.redis.hset(messageKey, messageField, JSON.stringify(message));

    await this.redis.sendCommand(
      new Redis.Command("HEXPIRE", [
        messageKey,
        60 * 60,
        "FIELDS",
        1,
        messageField,
      ]),
    );

    void this.to(type, id, "chat", message);
  }

  public async to(
    type: ChatLobbyType,
    id: string,
    event: "chat" | "list" | "messages" | "joined" | "left",
    data: Record<string, any>,
    sender?: FiveStackWebSocketClient,
  ) {
    const users = await this.getAllUsersInLobby(type, id);

    for (const { steamId } of users) {
      const sessions = this.sessions.get(steamId) || [];
      for (const session of sessions) {
        if (sender === session) {
          continue;
        }

        session.send(
          JSON.stringify({
            event: `lobby:${type}:${id}:${event}`,
            data: {
              ...data,
            },
          }),
        );
      }
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

    const sessions = this.sessions.get(client.user.steam_id) || [];
    const updatedSessions = sessions.filter((session) => session !== client);

    if (updatedSessions.length === 0) {
      this.sessions.delete(client.user.steam_id);
      await this.removeUserData(type, id, client.user.steam_id);
      void this.to(type, id, "left", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
      return;
    }

    this.sessions.set(client.user.steam_id, updatedSessions);

    if (userData.inGame) {
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

      return await rcon.send(`css_web_chat "${message}"`);
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

    const sessions = this.sessions.get(steamId) || [];
    if (sessions.length > 0) {
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
    await this.redis.del(this.getLobbyKey(type, id));
  }
}
