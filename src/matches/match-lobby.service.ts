import { Injectable, Logger } from "@nestjs/common";
import { User } from "../auth/types/User";
import Redis from "ioredis";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { HasuraService } from "../hasura/hasura.service";
import { RconService } from "../rcon/rcon.service";
import { FiveStackWebSocketClient } from "src/sockets/types/FiveStackWebSocketClient";

@Injectable()
export class MatchLobbyService {
  private redis: Redis;
  /**
   * TODO - put into redis ratehr than here because it wont scale
   */
  private matches: Record<
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
    matchId: string,
  ) {
    const { matches_by_pk } = await this.hasuraService.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
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

    const userData = this.addUserToMatch(matchId, client.user, false);

    if (userData.sessions.length === 0) {
      this.to(matchId, "lobby:joined", {
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
        event: "lobby:list",
        data: {
          matchId: matchId,
          lobby: Array.from(this.matches[matchId].values()).map(
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

    const messagesObject = await this.redis.hgetall(`chat_${matchId}`);

    const messages = Object.entries(messagesObject).map(([, value]) =>
      JSON.parse(value),
    );

    client.send(
      JSON.stringify({
        event: "lobby:messages",
        data: {
          messages: messages.sort((a, b) => {
            return (
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
          }),
          matchId: matchId,
        },
      }),
    );

    client.on("close", () => {
      this.removeFromLobby(matchId, client);
    });
  }

  public async sendMessageToChat(
    player: User,
    matchId: string,
    _message: string,
    skipCheck = false,
  ) {
    // verify they are in the lobby
    if (skipCheck === false && !this.matches[matchId]?.get(player.steam_id)) {
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

    const messageKey = `chat_${matchId}`;
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

    this.to(matchId, "lobby:chat", message);
  }

  public to(
    matchId: string,
    event:
      | "lobby:chat"
      | "lobby:list"
      | "lobby:messages"
      | "lobby:joined"
      | "lobby:left",
    data: Record<string, any>,
    sender?: FiveStackWebSocketClient,
  ) {
    const clients = this.matches?.[matchId];

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
            event,
            data: {
              matchId,
              ...data,
            },
          }),
        );
      }
    }
  }

  public removeFromLobby(matchId: string, client: FiveStackWebSocketClient) {
    const userData = this.matches[matchId]?.get(client.user.steam_id);

    if (!userData) {
      return;
    }

    userData.sessions = userData.sessions
      ? userData.sessions.filter((_client) => {
          return _client !== client;
        })
      : [];

    if (userData.inGame) {
      this.to(matchId, "lobby:joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });

      return;
    }

    if (userData.sessions.length === 0) {
      this.matches[matchId].delete(client.user.steam_id);
      this.to(matchId, "lobby:left", {
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

      const server = matches_by_pk.server;
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

    const userData = this.addUserToMatch(matchId, player, true);

    this.to(matchId, "lobby:joined", {
      user: {
        ...userData.user,
        inGame: userData.inGame,
      },
    });
  }

  public async leaveLobbyViaGame(matchId: string, steamId: string) {
    const userData = this.matches[matchId].get(steamId);

    if (userData) {
      userData.inGame = false;
    }

    if (userData.sessions.length > 0) {
      this.to(matchId, "lobby:joined", {
        user: {
          ...userData.user,
          inGame: userData.inGame,
        },
      });
      return;
    }

    this.matches[matchId].delete(steamId);

    this.to(matchId, "lobby:left", {
      user: {
        steam_id: steamId,
      },
    });
  }

  private addUserToMatch(matchId: string, user: User, game: boolean) {
    if (!this.matches[matchId]) {
      this.matches[matchId] = new Map();
    }

    let userData = this.matches[matchId].get(user.steam_id);

    if (!userData) {
      userData = {
        user,
        sessions: [],
      };
      this.matches[matchId].set(user.steam_id, userData);
    }

    if (game) {
      userData.inGame = true;
    }

    return userData;
  }
}
