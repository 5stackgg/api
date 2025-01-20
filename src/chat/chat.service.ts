import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { HasuraService } from "../hasura/hasura.service";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
@Injectable()
export class ChatService {
  private redis: Redis;
  /**
   * TODO - put into redis ratehr than here because it wont scale
   */
  private lobbies: Record<
    string,
    Map<
      string,
      {
        user: User;
        inGame?: Boolean;
        sessions: Array<FiveStackWebSocketClient>;
      }
    >
  > = {};

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
          client.user,
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
        console.warn(`Unknown lobby type: ${type}`);
        return;
        break;
    }

    const userData = this.addUserToLobby(id, client.user, false);

    if (userData.sessions.length === 0) {
      this.to(ChatLobbyType.Match, id, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
    }

    if (userData.sessions.includes(client)) {
      return;
    }

    userData.sessions.push(client);

    client.send(
      JSON.stringify({
        event: `lobby:${type}:${id}:list`,
        data: {
          lobby: Array.from(this.lobbies[id].values()).map(
            ({ user, inGame }) => {
              return {
                inGame,
                ...user,
              };
            },
          ),
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
      this.removeFromLobby(type, id, client);
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
    if (skipCheck === false && !this.lobbies[id]?.get(player.steam_id)) {
      return;
    }

    const timestamp = new Date();

    // TODO - we should fetch the user on the UI instead
    const message = {
      message: _message,
      timestamp: timestamp.toISOString(),
      from: {
        role: player.role,
        name: player.name,
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

    this.to(type, id, "chat", message);
  }

  public to(
    type: ChatLobbyType,
    id: string,
    event: "chat" | "list" | "messages" | "joined" | "left",
    data: Record<string, any>,
    sender?: FiveStackWebSocketClient,
  ) {
    // TODO - genericize this
    const clients = this.lobbies?.[id];

    if (!clients) {
      return;
    }

    for (const [, userData] of clients) {
      for (const session of userData.sessions) {
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

  public removeFromLobby(
    type: ChatLobbyType,
    id: string,
    client: FiveStackWebSocketClient,
  ) {
    const userData = this.lobbies[id]?.get(client.user.steam_id);

    if (!userData) {
      return;
    }

    userData.sessions = userData.sessions
      ? userData.sessions.filter((_client) => {
          return _client !== client;
        })
      : [];

    if (userData.inGame) {
      this.to(type, id, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });

      return;
    }

    if (userData.sessions.length === 0) {
      this.lobbies[id].delete(client.user.steam_id);
      this.to(type, id, "left", {
        user: {
          steam_id: client.user.steam_id,
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

    const userData = this.addUserToLobby(matchId, player, true);

    this.to(ChatLobbyType.Match, matchId, "joined", {
      user: {
        ...userData.user,
        inGame: userData.inGame,
      },
    });
  }

  public async leaveLobbyViaGame(matchId: string, steamId: string) {
    const userData = this.lobbies[matchId].get(steamId);

    if (userData) {
      userData.inGame = false;
    }

    if (userData.sessions.length > 0) {
      this.to(ChatLobbyType.Match, matchId, "joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
      return;
    }

    this.lobbies[matchId].delete(steamId);

    this.to(ChatLobbyType.Match, matchId, "left", {
      user: {
        steam_id: steamId,
      },
    });
  }

  private addUserToLobby(matchId: string, user: User, game: boolean) {
    if (!this.lobbies[matchId]) {
      this.lobbies[matchId] = new Map();
    }

    let userData = this.lobbies[matchId].get(user.steam_id);

    if (!userData) {
      userData = {
        user,
        sessions: [],
      };
      this.lobbies[matchId].set(user.steam_id, userData);
    }

    if (game) {
      userData.inGame = true;
    }

    return userData;
  }
}
