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
  e_match_status_enum,
  e_notification_types_enum,
  e_player_roles_enum,
  e_tournament_free_agent_statuses_enum,
} from "generated/schema";
import { isRoleAbove, rolesAtOrAbove } from "src/utilities/isRoleAbove";
import { NotificationsService } from "src/notifications/notifications.service";
import { PushNotificationsService } from "src/notifications/push/push-notifications.service";
import { PostgresService } from "src/postgres/postgres.service";
import { PlayerBlocksService } from "src/player-blocks/player-blocks.service";
import { chatThreadKey } from "src/notifications/push/notification-delivery";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { directRoomId, parseDirectRoomId } from "./utilities/directRoomId";
import { ChatErrorCode } from "./enums/ChatErrorCode";
import { ChatMessage, ChatMessageSource } from "./types/ChatMessage";
import { ChatSendResult } from "./types/ChatSendResult";
import { ChatDeleteResult } from "./types/ChatDeleteResult";
import { ChatEditResult } from "./types/ChatEditResult";
import { ChatReactions } from "./types/ChatReactions";
import { ChatReactResult } from "./types/ChatReactResult";
import { MatchChatArchiveEntry } from "./types/MatchChatArchiveEntry";
import { MatchChatLog } from "./types/MatchChatLog";

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
    [ChatLobbyType.Tournament, 60 * 60 * 24 * 7],
    [ChatLobbyType.Organizer, 60 * 60 * 24],
  ]);

  private static readonly DEFAULT_TTL = 60 * 60;

  // Measured in UTF-16 code units, the same unit a textarea's maxlength counts.
  public static readonly MAX_MESSAGE_LENGTH = 2000;

  // What a relayed line is cut to in game. The game shows far less than a full
  // website message, and 2000 characters of multibyte text can outgrow an rcon
  // packet.
  public static readonly RCON_MESSAGE_MAX_LENGTH = 240;

  // How long an author may edit or delete what they sent from the website.
  public static readonly SELF_SERVICE_WINDOW_MS = 600_000;

  // A room message carries the clock of whichever pod stored it, and another
  // pod may be the one judging the window.
  private static readonly SELF_SERVICE_CLOCK_SKEW_MS = 5_000;

  private static readonly EDIT_ATTEMPTS = 3;

  // HSET drops a field's expiry, so the absolute expiry is read first and put
  // back: an edit never extends a message's life. Comparing against the value
  // that was read and checked keeps an edit from bringing back a message that
  // expired or was deleted in the meantime, or from overwriting another edit.
  //
  // KEYS[2] is a receipt for this one attempt. ioredis resends a command whose
  // reply was lost to a reconnect, seconds later, by which time the message may
  // have been deleted or edited again; the receipt is what tells that resend it
  // already applied, rather than reading as a failed swap and discarding the
  // audit row of an edit that happened.
  private static readonly EDIT_ROOM_MESSAGE_SCRIPT = `
    if redis.call('EXISTS', KEYS[2]) == 1 then
      return 1
    end
    if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then
      return 0
    end
    local expiresAt = redis.call('HPEXPIRETIME', KEYS[1], 'FIELDS', 1, ARGV[1])[1]
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
    if expiresAt > 0 then
      redis.call('HPEXPIREAT', KEYS[1], expiresAt, 'FIELDS', 1, ARGV[1])
    end
    redis.call('SET', KEYS[2], '1', 'PX', ARGV[4])
    return 1
  `;

  private static readonly EDIT_RECEIPT_TTL_MS = 60 * 60 * 1000;

  // One step, so an edit, a delete or a reaction in the old room lands either
  // before the move and is carried with it, or after it and finds nothing --
  // never on a copy that is about to be thrown away or written back.
  //
  // A room TTL of 0 drops a moved message at once, and its reactions must not
  // then be left behind with no expiry at all.
  private static readonly MOVE_ROOM_MESSAGES_SCRIPT = `
    local messages = redis.call('HGETALL', KEYS[1])
    for i = 1, #messages, 2 do
      redis.call('HSET', KEYS[2], messages[i], messages[i + 1])
      redis.call('HEXPIRE', KEYS[2], ARGV[1], 'FIELDS', 1, messages[i])
      local reactions = redis.call('HGET', KEYS[3], messages[i])
      local expiresAt = redis.call('HPEXPIRETIME', KEYS[2], 'FIELDS', 1, messages[i])[1]
      if reactions and expiresAt ~= -2 then
        redis.call('HSET', KEYS[4], messages[i], reactions)
        if expiresAt > 0 then
          redis.call('HPEXPIREAT', KEYS[4], expiresAt, 'FIELDS', 1, messages[i])
        end
      end
    end
    redis.call('DEL', KEYS[1], KEYS[3])
    return #messages / 2
  `;

  // The web maps each id to its glyph; laugh is 😂.
  public static readonly REACTIONS = [
    "thumbsup",
    "heart",
    "laugh",
    "fire",
    "wow",
    "sad",
    "thumbsdown",
    "skull",
    "sob",
    "rofl",
    "angry",
    "thinking",
    "eyes",
    "hundred",
    "target",
    "clap",
    "pray",
    "handshake",
    "tada",
    "cool",
    "salute",
    "muscle",
    "goat",
    "clown",
  ] as const;

  // Every toggle is a broadcast to the whole room, so this is what keeps one
  // client from flooding everyone else in it.
  public static readonly REACTION_RATE_LIMIT = 8;

  private static readonly REACTION_RATE_WINDOW_MS = 1_000;

  // Counted across every room: a web message accepted into a match room is
  // also an RCON command to its game server.
  public static readonly MESSAGE_RATE_LIMIT = 5;

  private static readonly MESSAGE_RATE_WINDOW_MS = 3_000;

  private static readonly RATE_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;

  // Reactions live beside the messages rather than inside their JSON, so they
  // never contend with an edit's compare-and-set. A message that is gone gets
  // none: they would outlive it with no expiry. HSET drops the field's expiry,
  // so the reactions are given the message's own, and go when it does.
  //
  // KEYS[3] is a receipt for this one toggle: ioredis resends a command whose
  // reply was lost to a reconnect, and a toggle run twice undoes itself.
  // ARGV[4] = '1' allows only taking a reaction back (a gagged player), and
  // 0 is the answer when this toggle would have added one.
  private static readonly TOGGLE_ROOM_REACTION_SCRIPT = `
    if redis.call('EXISTS', KEYS[3]) == 1 then
      return redis.call('HGET', KEYS[2], ARGV[1]) or '{}'
    end
    if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
      return false
    end
    local stored = redis.call('HGET', KEYS[2], ARGV[1])
    local reactions = {}
    if stored then
      reactions = cjson.decode(stored)
    end
    local reactors = {}
    local removed = false
    for _, steamId in ipairs(reactions[ARGV[2]] or {}) do
      if steamId == ARGV[3] then
        removed = true
      else
        table.insert(reactors, steamId)
      end
    end
    if not removed then
      if ARGV[4] == '1' then
        return 0
      end
      table.insert(reactors, ARGV[3])
    end
    if #reactors == 0 then
      reactions[ARGV[2]] = nil
    else
      reactions[ARGV[2]] = reactors
    end
    redis.call('SET', KEYS[3], '1', 'PX', ARGV[5])
    if next(reactions) == nil then
      redis.call('HDEL', KEYS[2], ARGV[1])
      return '{}'
    end
    local encoded = cjson.encode(reactions)
    redis.call('HSET', KEYS[2], ARGV[1], encoded)
    local expiresAt = redis.call('HPEXPIRETIME', KEYS[1], 'FIELDS', 1, ARGV[1])[1]
    if expiresAt > 0 then
      redis.call('HPEXPIREAT', KEYS[2], expiresAt, 'FIELDS', 1, ARGV[1])
    end
    return encoded
  `;

  private static readonly REACTION_RECEIPT_TTL_MS = 5 * 60 * 1000;

  // Each direct message's reactions as one object, for a query that has the
  // message as `dm`.
  private static readonly DIRECT_MESSAGE_REACTIONS = `LEFT JOIN LATERAL (
            SELECT jsonb_object_agg(grouped.reaction, grouped.steam_ids)
                     AS reactions
              FROM (
                SELECT r.reaction,
                       jsonb_agg(r.steam_id::text
                                 ORDER BY r.created_at, r.steam_id)
                         AS steam_ids
                  FROM public.direct_message_reactions r
                 WHERE r.message_id = dm.id
                 GROUP BY r.reaction
              ) grouped
          ) reactions ON true`;

  // Shared by every direct message edit and delete, so the author and window
  // are judged in the same statement that changes the row, on the database's
  // clock -- the one created_at was stamped with.
  private static readonly OWN_RECENT_DIRECT_MESSAGE = `id = $1::uuid
          AND room_id = $2
          AND from_steam_id = $3::bigint
          AND created_at > now() - make_interval(secs => $4::int)`;

  // The web keeps the room's tab open for the same window.
  public static readonly FINISHED_TOURNAMENT_CHAT_DAYS = 7;

  // A drafted free agent is on a roster and gets in that way; withdrawn means
  // they left the pool.
  private static readonly TOURNAMENT_CHAT_FREE_AGENT_STATUSES: e_tournament_free_agent_statuses_enum[] =
    ["registered", "waitlisted"];

  // Every match and team room line is copied here for staff to review after
  // the live rooms, which keep their own short lifetime, have expired. It is
  // no lobby type, so nothing can join it; the chat log is the only way in.
  public static readonly MATCH_CHAT_ARCHIVE_TTL = 60 * 60 * 24 * 7;

  private static readonly MATCH_CHAT_LOG_STATUSES: e_match_status_enum[] = [
    "Finished",
    "Tie",
    "Canceled",
    "Forfeit",
    "Surrendered",
  ];

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
      fallback: 60 * 60 * 24 * 7,
    },
    {
      setting: SystemSettingName.ChatTtlOrganizers,
      type: ChatLobbyType.Organizer,
      fallback: 60 * 60 * 24,
    },
  ];

  // Each update carries the message's whole reaction state, and the per
  // recipient block lookup can finish out of order, so a room's updates wait
  // for the one before them rather than letting an older state land last.
  private readonly reactionBroadcasts = new Map<string, Promise<void>>();

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly hasuraService: HasuraService,
    private readonly postgres: PostgresService,
    private readonly redisManager: RedisManagerService,
    private readonly pushNotifications: PushNotificationsService,
    private readonly playerBlocks: PlayerBlocksService,
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

    client.on("close", () => {
      void this.removeFromLobby(type, id, client);
    });

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
          messages: await this.historyFor(type, id, String(user.steam_id)),
        },
      }),
    );
  }

  // Judged on the database's clock, the one finished_at was stamped with. A
  // tournament finished before finished_at existed has none and stays closed.
  private async isTournamentChatOpen(id: string): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ chat_open: boolean }>>(
      `SELECT (status <> 'Finished'
               OR finished_at > now() - make_interval(days => $2::int)) AS chat_open
         FROM public.tournaments
        WHERE id = $1::uuid`,
      [id, ChatService.FINISHED_TOURNAMENT_CHAT_DAYS],
    );

    return row?.chat_open === true;
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

        // Truthiness, not `=== false`: is_match_organizer is NULL rather than
        // false for a match with no organizer (every matchmaking match), and a
        // strict comparison let anyone signed in into those rooms.
        if (
          !matches_by_pk.is_coach &&
          !matches_by_pk.is_in_lineup &&
          !matches_by_pk.is_organizer
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
                    {
                      // Nobody is on a roster until the draft runs, so in a
                      // free agent tournament this is everyone who signed up.
                      free_agents: {
                        player_steam_id: {
                          _eq: user.steam_id,
                        },
                        status: {
                          _in: ChatService.TOURNAMENT_CHAT_FREE_AGENT_STATUSES,
                        },
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

        if (!(await this.isTournamentChatOpen(id))) {
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

        // Anything else names the same pair under a room id that nothing
        // keyed on the canonical one -- the block trigger, the rail's filter
        // -- would ever match.
        if (id !== directRoomId(parties[0], parties[1])) {
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

        if (
          await this.playerBlocks.isBlockedEitherWay(
            String(user.steam_id),
            otherSteamId,
          )
        ) {
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

  // Hiding is one-directional: what the viewer blocked is left out, what
  // blocked the viewer is not, so nothing here tells anyone they were blocked.
  private async historyFor(
    type: ChatLobbyType,
    id: string,
    viewer: string,
  ): Promise<ChatMessage[]> {
    const [messages, blocked] = await Promise.all([
      this.getMessages(type, id),
      this.playerBlocks.blockedBy(viewer, ChatService.blockExemptRoles(type)),
    ]);

    return ChatService.withoutBlocked(messages, blocked);
  }

  // A moderator has to see a group room whole to moderate it. A DM is not
  // moderated, so a block closes it for them like for anyone.
  private static blockExemptRoles(
    type: ChatLobbyType,
  ): Array<e_player_roles_enum> {
    return type === ChatLobbyType.Direct ? [] : rolesAtOrAbove("moderator");
  }

  private static withoutBlocked(
    messages: ChatMessage[],
    blocked: Set<string> | undefined,
  ): ChatMessage[] {
    if (!blocked || blocked.size === 0) {
      return messages;
    }

    return messages
      .filter((message) => !blocked.has(ChatService.authorSteamId(message)))
      .map((message) => ({
        ...message,
        reactions: ChatService.withoutReactors(message.reactions, blocked),
      }));
  }

  private static withoutReactors(
    reactions: ChatReactions | undefined,
    blocked: Set<string> | undefined,
  ): ChatReactions {
    if (!blocked || blocked.size === 0) {
      return reactions ?? {};
    }

    return ChatService.orderedReactions(
      Object.fromEntries(
        Object.entries(reactions ?? {}).map(([reaction, steamIds]) => [
          reaction,
          steamIds.filter((steamId) => !blocked.has(steamId)),
        ]),
      ),
    );
  }

  private static reactorsOf(reactions: ChatReactions | undefined): string[] {
    return [...new Set(Object.values(reactions ?? {}).flat())];
  }

  private static peopleIn(messages: ChatMessage[]): string[] {
    return [
      ...new Set(
        messages
          .flatMap((message) => [
            ChatService.authorSteamId(message),
            ...ChatService.reactorsOf(message.reactions),
          ])
          .filter((steamId): steamId is string => steamId !== null),
      ),
    ];
  }

  // A room's history, from whichever store holds it. DMs are durable and live
  // in postgres; every other room is redis behind its own TTL.
  private async getMessages(type: ChatLobbyType, id: string) {
    if (type === ChatLobbyType.Direct) {
      return await this.getDirectMessages(id);
    }

    return await this.getRoomMessages(type, id);
  }

  // Both hashes are asked for at once, so this is still one round trip. A
  // reaction landing between the two reads is harmless: the room is sent the
  // message's whole reaction state every time one changes.
  private async getRoomMessages(
    type: ChatLobbyType,
    id: string,
  ): Promise<ChatMessage[]> {
    const [messages, reactions] = await Promise.all([
      this.redis.hgetall(`chat_${type}_${id}`),
      this.redis.hgetall(ChatService.reactionsKey(type, id)),
    ]);

    return Object.entries(messages)
      .map(
        ([messageId, value]): ChatMessage => ({
          ...(JSON.parse(value) as ChatMessage),
          reactions: ChatService.orderedReactions(
            reactions[messageId] ? JSON.parse(reactions[messageId]) : null,
          ),
        }),
      )
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
  }

  // The stores keep reactions in whatever order they like (a Lua table's,
  // jsonb's by key length), so clients are always handed the list's order.
  private static orderedReactions(
    state: ChatReactions | null | undefined,
  ): ChatReactions {
    return Object.fromEntries(
      ChatService.REACTIONS.filter(
        (reaction) => (state?.[reaction]?.length ?? 0) > 0,
      ).map((reaction) => [reaction, state[reaction]]),
    );
  }

  private static reactionsKey(type: ChatLobbyType, id: string) {
    return `chat_reactions_${type}_${id}`;
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

  // What a player typed on the website, or why it cannot be sent. Lines relayed
  // from the game are not held to this: the game has already limited them.
  public static messageText(
    raw: unknown,
  ): { text: string } | { error: ChatErrorCode } {
    if (typeof raw !== "string") {
      return { error: ChatErrorCode.Invalid };
    }

    const text = raw.trim();

    if (text.length === 0) {
      return { error: ChatErrorCode.Invalid };
    }

    if (text.length > ChatService.MAX_MESSAGE_LENGTH) {
      return { error: ChatErrorCode.TooLong };
    }

    return { text };
  }

  public async sendMessageToChat(
    type: ChatLobbyType,
    id: string,
    player: User,
    _message: string,
    skipCheck = false,
    source: ChatMessageSource = "web",
  ): Promise<ChatSendResult> {
    let text = _message;

    if (source === "web") {
      const parsed = ChatService.messageText(_message);

      if ("error" in parsed) {
        return { accepted: false, code: parsed.error };
      }

      if (
        !(await this.withinRate(
          `chat:message-rate:${player.steam_id}`,
          ChatService.MESSAGE_RATE_LIMIT,
          ChatService.MESSAGE_RATE_WINDOW_MS,
        ))
      ) {
        return { accepted: false, code: ChatErrorCode.RateLimited };
      }

      text = parsed.text;
    }

    if (skipCheck === false && !(await this.canPostIn(type, id, player))) {
      return { accepted: false, code: ChatErrorCode.NotAllowed };
    }

    // The game server already enforces a gag on what is typed in game, and a
    // gag is a sanction on group chat -- a conversation between friends is left
    // alone.
    if (
      source === "web" &&
      type !== ChatLobbyType.Direct &&
      (await this.isGagged(player.steam_id))
    ) {
      return { accepted: false, code: ChatErrorCode.Gagged };
    }

    const name = await this.redis.get(
      HasuraService.PLAYER_NAME_CACHE_KEY(player.steam_id),
    );

    const role = await this.redis.get(
      HasuraService.PLAYER_ROLE_CACHE_KEY(player.steam_id),
    );

    const timestamp = new Date();
    const message: ChatMessage = {
      // Both the history snapshot sent on join and the live broadcast carry the
      // message, so clients need something stable to recognize it by.
      id: randomUUID(),
      message: text,
      timestamp: timestamp.toISOString(),
      source,
      from: {
        role: ChatService.cachedOr<e_player_roles_enum>(role, player.role),
        name: ChatService.cachedOr(name, player.name),
        steam_id: String(player.steam_id),
        avatar_url: player.avatar_url,
        profile_url: player.profile_url,
      },
    };

    if (type === ChatLobbyType.Direct) {
      if (!(await this.storeDirectMessage(id, message))) {
        return { accepted: false, code: ChatErrorCode.NotAllowed };
      }
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

      await this.archiveMessages(type, id, [message]);
    }

    const outgoing: ChatMessage = { ...message, reactions: {} };

    void this.to(type, id, "chat", outgoing, message.from.steam_id).catch(
      (error) => {
        this.logger.warn(
          `unable to broadcast a message to ${type}:${id}`,
          error,
        );
      },
    );

    if (type === ChatLobbyType.Direct) {
      void this.deliverDirectMessage(id, player, outgoing);
    }

    // Best effort, and never allowed to take a message delivery down with it.
    void this.notifyLobbyMembers(
      type,
      id,
      player,
      message.from.name,
      text,
      message.id,
    ).catch((error) => {
      this.logger.warn(`unable to notify ${type}:${id} of a message`, error);
    });

    return { accepted: true, messageId: message.id };
  }

  // Presence in the room only says someone joined it once: it lives in redis
  // for a day, is refreshed by anyone else joining, and the game server seats
  // whoever connects. Membership lapses underneath it -- a player swapped out
  // of a live match, a free agent who withdrew, an unfriend -- so every send is
  // held to the same rule as joining. Draft has its own, stricter once the
  // match has been drafted.
  private async canPostIn(
    type: ChatLobbyType,
    id: string,
    user: User,
  ): Promise<boolean> {
    if (!(await this.getUserData(type, id, user.steam_id))) {
      return false;
    }

    if (type === ChatLobbyType.Draft) {
      return await this.canSendDraftMessage(id, user);
    }

    return await this.canAccessLobby(type, id, user);
  }

  private async isGagged(steamId: string): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ gagged: boolean }>>(
      `SELECT public.is_gagged(p) AS gagged
         FROM public.players p
        WHERE p.steam_id = $1::bigint`,
      [String(steamId)],
    );

    return row?.gagged === true;
  }

  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  public async deleteMessage(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    user: User,
  ): Promise<ChatDeleteResult> {
    if (!ChatService.UUID.test(messageId)) {
      return { deleted: false, code: ChatErrorCode.NotFound };
    }

    if (type === ChatLobbyType.Direct) {
      return await this.deleteDirectMessage(id, messageId, user);
    }

    const current = await this.getCurrentUser(user.steam_id);

    if (!current) {
      return { deleted: false, code: ChatErrorCode.NotAllowed };
    }

    const messageKey = `chat_${type}_${id}`;
    const raw = await this.redis.hget(messageKey, messageId);

    if (!raw) {
      return { deleted: false, code: ChatErrorCode.NotFound };
    }

    const message = JSON.parse(raw) as ChatMessage;

    const refusal = await this.deleteRefusal(message, type, id, current);

    if (refusal) {
      return { deleted: false, code: refusal };
    }

    // Audited before it is removed, so no failure part way through can take a
    // message down without its evidence. A retry finds the row and carries on.
    // An author removing their own message is audited the same way, or posting
    // abuse and deleting it would leave nothing behind.
    await this.recordDeletion(type, id, messageId, message, current);

    await this.updateArchivedMessage(type, id, messageId, (entry) => ({
      ...entry,
      deleted_at: new Date().toISOString(),
      deleted_by: String(current.steam_id),
    }));

    await this.redis.hdel(messageKey, messageId);

    // Never allowed to stop the delete being announced: left behind, the
    // reactions still expire with the message, and nothing reads reactions
    // for a message that is gone.
    await this.redis
      .hdel(ChatService.reactionsKey(type, id), messageId)
      .catch((error) => {
        this.logger.warn(
          `unable to clear reactions for ${type}:${id} message ${messageId}`,
          error,
        );
      });

    void this.to(type, id, "deleted", { id: messageId });

    await this.retractNotifications(type, id, messageId);

    return { deleted: true };
  }

  private async deleteRefusal(
    message: ChatMessage,
    type: ChatLobbyType,
    id: string,
    user: User,
  ): Promise<ChatErrorCode | null> {
    if (!isRoleAbove(user.role, "moderator")) {
      const refusal = ChatService.selfServiceRefusal(message, user);

      if (refusal) {
        return refusal;
      }
    }

    if (!(await this.canAccessLobby(type, id, user))) {
      return ChatErrorCode.NotAllowed;
    }

    return null;
  }

  // Only what the author typed on the website is theirs to change: a line
  // relayed from the game, or one stored before `source` was recorded, is not.
  // No role gets past this -- nobody edits another player's words.
  private static selfServiceRefusal(
    message: ChatMessage,
    user: User,
  ): ChatErrorCode | null {
    if (
      message.source !== "web" ||
      ChatService.authorSteamId(message) !== String(user.steam_id)
    ) {
      return ChatErrorCode.NotAllowed;
    }

    const sentAt = new Date(message.timestamp).getTime();

    if (
      Number.isNaN(sentAt) ||
      Date.now() - sentAt >
        ChatService.SELF_SERVICE_WINDOW_MS +
          ChatService.SELF_SERVICE_CLOCK_SKEW_MS
    ) {
      return ChatErrorCode.WindowClosed;
    }

    return null;
  }

  public async editMessage(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    user: User,
    raw: unknown,
  ): Promise<ChatEditResult> {
    const parsed = ChatService.messageText(raw);

    if ("error" in parsed) {
      return { edited: false, code: parsed.error };
    }

    if (!ChatService.UUID.test(messageId)) {
      return { edited: false, code: ChatErrorCode.NotFound };
    }

    if (type === ChatLobbyType.Direct) {
      return await this.editDirectMessage(id, messageId, user, parsed.text);
    }

    const current = await this.getCurrentUser(user.steam_id);

    if (!current) {
      return { edited: false, code: ChatErrorCode.NotAllowed };
    }

    return await this.editRoomMessage(
      type,
      id,
      messageId,
      current,
      parsed.text,
    );
  }

  public static isReaction(
    value: unknown,
  ): value is (typeof ChatService.REACTIONS)[number] {
    return (ChatService.REACTIONS as readonly unknown[]).includes(value);
  }

  // Never a notification and never relayed to the game: the room is sent the
  // message's whole reaction state, so a client that missed a toggle is right
  // again with the next one.
  public async toggleReaction(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    reaction: unknown,
    user: User,
  ): Promise<ChatReactResult> {
    if (!ChatService.isReaction(reaction)) {
      return { toggled: false, code: ChatErrorCode.Invalid };
    }

    if (!ChatService.UUID.test(messageId)) {
      return { toggled: false, code: ChatErrorCode.NotFound };
    }

    if (
      !(await this.withinRate(
        `chat:reaction-rate:${user.steam_id}`,
        ChatService.REACTION_RATE_LIMIT,
        ChatService.REACTION_RATE_WINDOW_MS,
      ))
    ) {
      return { toggled: false, code: ChatErrorCode.RateLimited };
    }

    if (!(await this.canPostIn(type, id, user))) {
      return { toggled: false, code: ChatErrorCode.NotAllowed };
    }

    const reactions =
      type === ChatLobbyType.Direct
        ? await this.toggleDirectReaction(id, messageId, reaction, user)
        : await this.toggleRoomReaction(
            type,
            id,
            messageId,
            reaction,
            user,
            // Like deleting their own message, taking a reaction back is not
            // speech, so a gag leaves it alone.
            await this.isGagged(user.steam_id),
          );

    if (reactions === "gagged") {
      return { toggled: false, code: ChatErrorCode.Gagged };
    }

    if (!reactions) {
      return { toggled: false, code: ChatErrorCode.NotFound };
    }

    void this.broadcastReaction(type, id, messageId, reactions);

    return { toggled: true, reactions };
  }

  private broadcastReaction(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    reactions: ChatReactions,
  ): Promise<void> {
    const room = `${type}:${id}`;

    const broadcast = (this.reactionBroadcasts.get(room) ?? Promise.resolve())
      .then(() => this.to(type, id, "reaction", { id: messageId, reactions }))
      .catch((error) => {
        this.logger.warn(`unable to broadcast a reaction to ${room}`, error);
      })
      .finally(() => {
        if (this.reactionBroadcasts.get(room) === broadcast) {
          this.reactionBroadcasts.delete(room);
        }
      });

    this.reactionBroadcasts.set(room, broadcast);

    return broadcast;
  }

  private async withinRate(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    const count = await this.redis.eval(
      ChatService.RATE_SCRIPT,
      1,
      key,
      windowMs,
    );

    return Number(count) <= limit;
  }

  private async toggleRoomReaction(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    reaction: string,
    user: User,
    removeOnly: boolean,
  ): Promise<ChatReactions | "gagged" | null> {
    const state = await this.redis.eval(
      ChatService.TOGGLE_ROOM_REACTION_SCRIPT,
      3,
      `chat_${type}_${id}`,
      ChatService.reactionsKey(type, id),
      `chat_reaction_applied:${randomUUID()}`,
      messageId,
      reaction,
      String(user.steam_id),
      removeOnly ? "1" : "0",
      ChatService.REACTION_RECEIPT_TTL_MS,
    );

    if (state === 0) {
      return "gagged";
    }

    if (typeof state !== "string") {
      return null;
    }

    return ChatService.orderedReactions(JSON.parse(state));
  }

  private async toggleDirectReaction(
    roomId: string,
    messageId: string,
    reaction: string,
    user: User,
  ): Promise<ChatReactions | null> {
    return await this.postgres.transaction(async (client) => {
      // Toggles on one message take turns here, and each then starts its
      // statement after the last one committed. Two toggles on an absent row
      // in one snapshot would both insert, and the second would quietly do
      // nothing instead of taking it back. The lock also holds off the
      // message's deletion until the reaction is written.
      const { rows: found } = await client.query(
        `SELECT 1 FROM public.direct_messages
          WHERE id = $1::uuid AND room_id = $2
            FOR NO KEY UPDATE`,
        [messageId, roomId],
      );

      if (found.length === 0) {
        return null;
      }

      await client.query(
        `WITH removed AS (
           DELETE FROM public.direct_message_reactions
            WHERE message_id = $1::uuid
              AND steam_id = $2::bigint
              AND reaction = $3
        RETURNING 1
         )
         INSERT INTO public.direct_message_reactions
                (message_id, steam_id, reaction)
              SELECT $1::uuid, $2::bigint, $3
               WHERE NOT EXISTS (SELECT 1 FROM removed)
                 AND EXISTS (
                   SELECT 1 FROM public.direct_messages
                    WHERE id = $1::uuid AND room_id = $4
                 )
         ON CONFLICT DO NOTHING`,
        [messageId, String(user.steam_id), reaction, roomId],
      );

      const {
        rows: [row],
      } = await client.query<{ reactions: ChatReactions | null }>(
        `SELECT reactions.reactions
           FROM public.direct_messages dm
           ${ChatService.DIRECT_MESSAGE_REACTIONS}
          WHERE dm.id = $1::uuid`,
        [messageId],
      );

      return ChatService.orderedReactions(row?.reactions);
    });
  }

  private async editRoomMessage(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    user: User,
    text: string,
  ): Promise<ChatEditResult> {
    const messageKey = `chat_${type}_${id}`;
    let admitted = false;

    for (let attempt = 0; attempt < ChatService.EDIT_ATTEMPTS; attempt++) {
      const raw = await this.redis.hget(messageKey, messageId);

      if (!raw) {
        return { edited: false, code: ChatErrorCode.NotFound };
      }

      const message = JSON.parse(raw) as ChatMessage;
      const refusal = ChatService.selfServiceRefusal(message, user);

      if (refusal) {
        return { edited: false, code: refusal };
      }

      if (!admitted) {
        if (!(await this.canAccessLobby(type, id, user))) {
          return { edited: false, code: ChatErrorCode.NotAllowed };
        }

        if (await this.isGagged(user.steam_id)) {
          return { edited: false, code: ChatErrorCode.Gagged };
        }

        admitted = true;
      }

      const editedAt = new Date().toISOString();

      // Written before the swap, the way a deletion is audited before its
      // HDEL, so no failure part way through can replace what was said
      // without keeping it. A swap that does not apply takes its row back out.
      const auditId = await this.recordEdit(
        type,
        id,
        messageId,
        message,
        text,
        editedAt,
      );

      const swapped = await this.redis.eval(
        ChatService.EDIT_ROOM_MESSAGE_SCRIPT,
        2,
        messageKey,
        `chat_edit_applied:${auditId}`,
        messageId,
        raw,
        JSON.stringify({ ...message, message: text, edited_at: editedAt }),
        ChatService.EDIT_RECEIPT_TTL_MS,
      );

      if (swapped === 1) {
        await this.updateArchivedMessage(type, id, messageId, (entry) => ({
          ...entry,
          message: text,
          edited_at: editedAt,
          edits: [
            ...(entry.edits ?? []),
            { message: entry.message, edited_at: editedAt },
          ],
        }));

        return await this.announceEdit(
          type,
          id,
          messageId,
          String(user.steam_id),
          text,
          editedAt,
        );
      }

      await this.discardEdit(auditId);
    }

    this.logger.warn(
      `gave up editing ${type}:${id} message ${messageId}, it kept changing`,
    );

    return { edited: false, code: ChatErrorCode.Invalid };
  }

  private async editDirectMessage(
    roomId: string,
    messageId: string,
    user: User,
    text: string,
  ): Promise<ChatEditResult> {
    if (!(await this.canAccessLobby(ChatLobbyType.Direct, roomId, user))) {
      return { edited: false, code: ChatErrorCode.NotAllowed };
    }

    const refusal = await this.directMessageRefusal(roomId, messageId, user);

    if (refusal) {
      return { edited: false, code: refusal };
    }

    const [row] = await this.postgres.query<
      Array<{ message: string; edited_at: Date }>
    >(
      `UPDATE public.direct_messages
          SET message = $5, edited_at = now()
        WHERE ${ChatService.OWN_RECENT_DIRECT_MESSAGE}
    RETURNING message, edited_at`,
      [...ChatService.ownRecentDirectMessage(roomId, messageId, user), text],
    );

    if (!row) {
      return {
        edited: false,
        code:
          (await this.directMessageRefusal(roomId, messageId, user)) ??
          ChatErrorCode.NotFound,
      };
    }

    return await this.announceEdit(
      ChatLobbyType.Direct,
      roomId,
      messageId,
      String(user.steam_id),
      row.message,
      new Date(row.edited_at).toISOString(),
    );
  }

  private async deleteDirectMessage(
    roomId: string,
    messageId: string,
    user: User,
  ): Promise<ChatDeleteResult> {
    if (!(await this.canAccessLobby(ChatLobbyType.Direct, roomId, user))) {
      return { deleted: false, code: ChatErrorCode.NotAllowed };
    }

    const refusal = await this.directMessageRefusal(roomId, messageId, user);

    if (refusal) {
      return { deleted: false, code: refusal };
    }

    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `DELETE FROM public.direct_messages
        WHERE ${ChatService.OWN_RECENT_DIRECT_MESSAGE}
    RETURNING id::text AS id`,
      ChatService.ownRecentDirectMessage(roomId, messageId, user),
    );

    if (!row) {
      return {
        deleted: false,
        code:
          (await this.directMessageRefusal(roomId, messageId, user)) ??
          ChatErrorCode.NotFound,
      };
    }

    // Deleting the first message of a conversation would otherwise leave an
    // empty tab on the recipient's rail, telling them something was sent.
    await this.postgres.query(
      `DELETE FROM public.direct_conversations
        WHERE room_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM public.direct_messages WHERE room_id = $1
          )`,
      [roomId],
    );

    void this.to(ChatLobbyType.Direct, roomId, "deleted", { id: messageId });

    await this.retractNotifications(ChatLobbyType.Direct, roomId, messageId);

    return { deleted: true };
  }

  private static ownRecentDirectMessage(
    roomId: string,
    messageId: string,
    user: User,
  ) {
    return [
      messageId,
      roomId,
      String(user.steam_id),
      ChatService.SELF_SERVICE_WINDOW_MS / 1000,
    ];
  }

  // Read apart from the statement that acts on it, so a refusal can say why.
  private async directMessageRefusal(
    roomId: string,
    messageId: string,
    user: User,
  ): Promise<ChatErrorCode | null> {
    const [row] = await this.postgres.query<
      Array<{ author: string; open: boolean }>
    >(
      `SELECT from_steam_id::text AS author,
              created_at > now() - make_interval(secs => $3::int) AS open
         FROM public.direct_messages
        WHERE id = $1::uuid AND room_id = $2`,
      [messageId, roomId, ChatService.SELF_SERVICE_WINDOW_MS / 1000],
    );

    if (!row) {
      return ChatErrorCode.NotFound;
    }

    if (row.author !== String(user.steam_id)) {
      return ChatErrorCode.NotAllowed;
    }

    if (!row.open) {
      return ChatErrorCode.WindowClosed;
    }

    return null;
  }

  // Never relayed to the game server, and no new notification: a push still
  // being held for the message just says what it says now.
  private async announceEdit(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    author: string,
    text: string,
    editedAt: string,
  ): Promise<ChatEditResult> {
    void this.to(
      type,
      id,
      "edited",
      {
        id: messageId,
        message: text,
        edited_at: editedAt,
      },
      author,
    ).catch((error) => {
      this.logger.warn(`unable to broadcast an edit to ${type}:${id}`, error);
    });

    await this.pushNotifications
      .editChatMessage(messageId, ChatService.notificationPreview(text))
      .catch((error) => {
        this.logger.warn(
          `unable to update notifications for ${type}:${id} message ${messageId}`,
          error,
        );
      });

    return { edited: true, message: text, edited_at: editedAt };
  }

  private async retractNotifications(
    type: ChatLobbyType,
    id: string,
    messageId: string,
  ) {
    await this.pushNotifications
      .retractChatMessage(messageId)
      .catch((error) => {
        this.logger.warn(
          `unable to retract notifications for ${type}:${id} message ${messageId}`,
          error,
        );
      });
  }

  private async recordDeletion(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    message: ChatMessage,
    deletedBy: User,
  ) {
    await this.postgres.query(
      `INSERT INTO public.chat_message_deletions
              (message_id, room_type, room_id, author_steam_id, message,
               message_created_at, source, deleted_by_steam_id)
            SELECT $1::uuid, $2, $3,
                   (SELECT steam_id FROM public.players
                     WHERE steam_id = $4::bigint),
                   $5, $6::timestamptz, $7, $8::bigint
       ON CONFLICT (room_type, room_id, message_id) DO NOTHING`,
      [
        messageId,
        type,
        id,
        ChatService.authorSteamId(message),
        String(message.message ?? ""),
        ChatService.messageCreatedAt(message),
        message.source ?? null,
        deletedBy.steam_id,
      ],
    );
  }

  // edited_at is the one the message itself now carries, so a row can be
  // matched to the edit clients were shown.
  private async recordEdit(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    message: ChatMessage,
    text: string,
    editedAt: string,
  ): Promise<string> {
    const [row] = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.chat_message_edits
              (message_id, room_type, room_id, author_steam_id,
               previous_message, new_message, message_created_at, edited_at)
            SELECT $1::uuid, $2, $3,
                   (SELECT steam_id FROM public.players
                     WHERE steam_id = $4::bigint),
                   $5, $6, $7::timestamptz, $8::timestamptz
         RETURNING id::text AS id`,
      [
        messageId,
        type,
        id,
        ChatService.authorSteamId(message),
        String(message.message ?? ""),
        text,
        ChatService.messageCreatedAt(message),
        editedAt,
      ],
    );

    return row.id;
  }

  // Only for a swap that found the message gone or changed, so the edit never
  // happened. A swap that failed outright keeps its row: it may have applied.
  private async discardEdit(auditId: string) {
    await this.postgres
      .query(`DELETE FROM public.chat_message_edits WHERE id = $1::uuid`, [
        auditId,
      ])
      .catch((error) => {
        this.logger.warn(
          `unable to discard the audit row of an edit that did not apply`,
          error,
        );
      });
  }

  private static messageCreatedAt(message: ChatMessage): string | null {
    const sentAt = new Date(message.timestamp);

    return Number.isNaN(sentAt.getTime()) ? null : sentAt.toISOString();
  }

  // A steam id stored as a JSON number has already been rounded by JSON.parse
  // onto some other account, and would pin the message on the wrong player.
  private static authorSteamId(message: ChatMessage): string | null {
    const steamId: unknown = message.from?.steam_id;

    if (typeof steamId !== "string" || !/^\d{1,20}$/.test(steamId)) {
      return null;
    }

    return steamId;
  }

  // The name and role caches are separate keys with separate lifetimes, so
  // either can be missing while the other is not.
  private static cachedOr<T>(cached: string | null, fallback: T): T {
    if (cached === null) {
      return fallback;
    }

    return (JSON.parse(cached) as T) ?? fallback;
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
  // because a burst's summary goes out seconds after its messages, which is
  // precisely when someone opens the conversation. See
  // notifications/push/push-notifications.service.ts.
  private async notifyLobbyMembers(
    type: ChatLobbyType,
    id: string,
    sender: User,
    senderName: string,
    message: string,
    messageId: string,
  ) {
    const members = await this.getLobbyMemberSteamIds(type, id);
    const senderSteamId = String(sender.steam_id);

    const others = members.filter((steamId) => steamId !== senderSteamId);
    const hiding = await this.playerBlocks.blockedAmong(
      others,
      [senderSteamId],
      ChatService.blockExemptRoles(type),
    );
    const targets = others.filter((steamId) => !hiding.has(steamId));

    if (targets.length === 0) {
      return;
    }

    await this.pushNotifications.sendChatMessage(targets, {
      messageId,
      type: ChatService.notificationTypeFor(type),
      title: senderName,
      message: ChatService.notificationPreview(message),
      entityId: `${type}:${id}`,
      threadKey: chatThreadKey(type, id),
      threadLabel: await this.threadLabel(type, id, sender),
      icon: sender.avatar_url,
      senderSteamId,
      blockExemptRoles: ChatService.blockExemptRoles(type),
    });
  }

  private static notificationPreview(message: string) {
    return NotificationsService.escapeHtml(
      message.length > 140 ? `${message.slice(0, 140)}…` : message,
    );
  }

  // Match chat is its own notification type, and so its own push category.
  //
  // Every line typed in-game is relayed -- all chat into the match room by
  // ChatMessageEvent, team chat into the lineup's team room by
  // TeamChatMessageEvent -- so a live match fires this per lineup member per
  // line, and the player it reaches is the one already reading those lines in
  // the game. Sharing a category with direct messages meant the only way to
  // stop that was to mute DMs too.
  public static notificationTypeFor(
    type: ChatLobbyType,
  ): e_notification_types_enum {
    return type === ChatLobbyType.Match || type === ChatLobbyType.MatchTeam
      ? "MatchChatMessage"
      : "ChatMessage";
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
            free_agents: {
              __args: {
                where: {
                  status: {
                    _in: ChatService.TOURNAMENT_CHAT_FREE_AGENT_STATUSES,
                  },
                },
              },
              player_steam_id: true,
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

        for (const freeAgent of tournaments_by_pk?.free_agents ?? []) {
          add(freeAgent.player_steam_id);
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
        // Not narrowed to recently active staff. The list is small, and the
        // push only reaches those with a device subscribed.
        for (const steamId of await this.organizerSteamIds()) {
          add(steamId);
        }

        break;
      }
      default:
        // Nothing ever opens a Team room, so it has nobody to notify.
        break;
    }

    return [...steamIds];
  }

  // Cached for the same reason threadLabel is: left uncached this is a
  // role-filtered scan of `players` for every line typed in the organizers'
  // room, and the staff roster changes even less often than the room's name.
  //
  // A much shorter TTL than the label's, though. This one is membership: a
  // demoted organizer keeps being notified of staff-room traffic until the key
  // expires, so the window is kept to a minute. That still collapses a busy
  // conversation into one query a minute rather than one per message.
  private async organizerSteamIds(): Promise<string[]> {
    const cacheKey = "chat:organizers";
    const cached = await this.redis.get(cacheKey);

    if (cached !== null) {
      return JSON.parse(cached) as string[];
    }

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

    const steamIds = (players ?? []).map(({ steam_id }) => String(steam_id));

    await this.redis.set(cacheKey, JSON.stringify(steamIds), "EX", 60);

    return steamIds;
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

      if (
        await this.playerBlocks.hasBlocked(steamId, String(sender.steam_id))
      ) {
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
  //
  // A block committed after the send's access check still stops the insert,
  // and with it the rail, the delivery and the notification.
  private async storeDirectMessage(
    roomId: string,
    message: { id: string; message: string; from: User },
  ): Promise<boolean> {
    const parties = parseDirectRoomId(roomId);

    if (!parties) {
      return false;
    }

    const stored = await this.postgres.query<Array<{ id: string }>>(
      `INSERT INTO public.direct_messages (id, room_id, from_steam_id, message)
            SELECT $1::uuid, $2, $3::bigint, $4
             WHERE NOT public.is_blocked_either_way(
                     split_part($2, ':', 1)::bigint,
                     split_part($2, ':', 2)::bigint)
         RETURNING id::text AS id`,
      [message.id, roomId, message.from.steam_id, message.message],
    );

    if (stored.length === 0) {
      return false;
    }

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

    return true;
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
        edited_at: Date | null;
        reactions: ChatReactions | null;
        steam_id: string;
        name: string;
        role: e_player_roles_enum;
        avatar_url: string | null;
        profile_url: string | null;
      }>
    >(
      `SELECT dm.id::text AS id, dm.message, dm.created_at, dm.edited_at,
              reactions.reactions,
              p.steam_id::text AS steam_id, p.name, p.role::text AS role,
              p.avatar_url, p.profile_url
         FROM public.direct_messages dm
         JOIN public.players p ON p.steam_id = dm.from_steam_id
         ${ChatService.DIRECT_MESSAGE_REACTIONS}
        WHERE dm.room_id = $1
        ORDER BY dm.created_at DESC, dm.seq DESC
        LIMIT 200`,
      [roomId],
    );

    return rows.reverse().map(
      (row): ChatMessage => ({
        id: row.id,
        message: row.message,
        timestamp: new Date(row.created_at).toISOString(),
        // Nothing relays from the game into a DM.
        source: "web",
        ...(row.edited_at
          ? { edited_at: new Date(row.edited_at).toISOString() }
          : {}),
        reactions: ChatService.orderedReactions(row.reactions),
        from: {
          role: row.role,
          name: row.name,
          steam_id: row.steam_id,
          avatar_url: row.avatar_url,
          profile_url: row.profile_url,
        },
      }),
    );
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
          -- Only the blocker's rail: the other side's stays as it was, so it
          -- does not tell them. The room id is directRoomId()'s.
          AND NOT EXISTS (
            SELECT 1
              FROM public.player_blocks pb
             WHERE pb.blocker_steam_id = dc.steam_id
               AND dc.room_id =
                   LEAST(pb.blocker_steam_id, pb.blocked_steam_id)::text
                   || ':' ||
                   GREATEST(pb.blocker_steam_id, pb.blocked_steam_id)::text
          )
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
  // itself -- and counting server side would mean reaching into every lobby's
  // redis hash on page load.
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

  // What someone said, and whom they reacted with, never reaches a player who
  // blocked them. History is per recipient, so it has no way out through
  // here: see resendHistory.
  public to(
    type: ChatLobbyType,
    id: string,
    event: "chat" | "edited",
    data: Record<string, any>,
    author: string,
  ): Promise<void>;
  public to(
    type: ChatLobbyType,
    id: string,
    event: "reaction",
    data: { id: string; reactions: ChatReactions },
  ): Promise<void>;
  public to(
    type: ChatLobbyType,
    id: string,
    event: "deleted" | "list" | "joined" | "left",
    data: Record<string, any>,
  ): Promise<void>;
  public async to(
    type: ChatLobbyType,
    id: string,
    event: string,
    data: Record<string, any>,
    author?: string,
  ): Promise<void> {
    const users = await this.getAllUsersInLobby(type, id);
    const eventName = `lobby:${type}:${id}:${event}`;
    const roster = await this.teamRoomRoster(type, id);

    const hiding = await this.playerBlocks.blockedAmong(
      users.map(({ steamId }) => steamId),
      event === "reaction"
        ? ChatService.reactorsOf(data.reactions)
        : author === undefined
          ? []
          : [author],
      ChatService.blockExemptRoles(type),
    );

    for (const { steamId } of users) {
      if (roster && !roster.has(String(steamId))) {
        continue;
      }

      const blocked = hiding.get(steamId);

      if (event === "reaction") {
        await this.publishTo(steamId, eventName, {
          ...data,
          reactions: ChatService.withoutReactors(data.reactions, blocked),
        });
        continue;
      }

      if (blocked) {
        continue;
      }

      await this.publishTo(steamId, eventName, data);
    }
  }

  private async resendHistory(
    type: ChatLobbyType,
    id: string,
    messages: ChatMessage[],
  ) {
    const users = await this.getAllUsersInLobby(type, id);
    const blocked = await this.playerBlocks.blockedAmong(
      users.map(({ steamId }) => steamId),
      ChatService.peopleIn(messages),
      ChatService.blockExemptRoles(type),
    );

    for (const { steamId } of users) {
      await this.publishTo(steamId, `lobby:${type}:${id}:messages`, {
        id,
        messages: ChatService.withoutBlocked(messages, blocked.get(steamId)),
      });
    }
  }

  private async publishTo(
    steamId: string,
    event: string,
    data: Record<string, any>,
  ) {
    await this.redis.publish(
      "send-message-to-steam-id",
      JSON.stringify({ steamId, event, data }),
    );
  }

  // Presence outlives membership (see canPostIn), and a team room is the one
  // whose lines the rest of the match must never see: a player moved to the
  // other lineup, or benched, would otherwise keep receiving them until their
  // presence expired.
  private async teamRoomRoster(
    type: ChatLobbyType,
    id: string,
  ): Promise<Set<string> | null> {
    if (type !== ChatLobbyType.MatchTeam) {
      return null;
    }

    return new Set(await this.getLobbyMemberSteamIds(type, id));
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

  // The message is inlined into an rcon command inside quotes, so a quote ends
  // the argument and a newline ends the command: either one turns the rest of
  // what a player typed into console input. Chat in game is one line anyway.
  // SwiftlyS2's tokenizer also reads U+200B as a quote, which would split the
  // line into tokens the plugin never shows.
  private static oneRconArgument(message: string) {
    return message
      .replace(/[\r\n]+/g, " ")
      .replace(/["\u200b]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, "")
      .trim();
  }

  private static readonly GRAPHEMES = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });

  // Counted in code points, which bounds the bytes an rcon packet has to carry
  // whatever the script. Cut only between graphemes, so a flag or a joined
  // emoji at the boundary is dropped whole rather than left in pieces.
  private static clampForGame(message: string) {
    const limit = ChatService.RCON_MESSAGE_MAX_LENGTH;

    if (Array.from(message).length <= limit) {
      return message;
    }

    let clamped = "";
    let length = 0;

    for (const { segment } of ChatService.GRAPHEMES.segment(message)) {
      const size = Array.from(segment).length;

      if (length + size > limit - 1) {
        break;
      }

      clamped += segment;
      length += size;
    }

    return `${clamped.trimEnd()}…`;
  }

  public async sendChatToServer(
    matchId: string,
    message: string,
    isOrganizer = false,
  ) {
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

      return await rcon.send(
        `${command} "${ChatService.clampForGame(ChatService.oneRconArgument(message))}" ${isOrganizer ? 1 : 0}`,
      );
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

  // Staff at match organizer and above, by the role held now, once the match
  // has ended. Someone who took part (on a lineup or coaching now, or seen
  // writing in a team room) gets all chat only. Blocks are not applied:
  // reviewing a match means seeing every line of it.
  public async matchChatLog(
    matchId: string,
    user: User | undefined,
  ): Promise<MatchChatLog | null> {
    if (!user?.steam_id || !ChatService.UUID.test(matchId)) {
      return null;
    }

    const current = await this.getCurrentUser(user.steam_id);

    if (!current || !isRoleAbove(current.role, "match_organizer")) {
      return null;
    }

    const viewer = String(current.steam_id);

    const [match] = await this.postgres.query<
      Array<{
        status: e_match_status_enum;
        lineup_1_id: string | null;
        lineup_2_id: string | null;
        on_lineup: boolean;
      }>
    >(
      `SELECT m.status, m.lineup_1_id::text, m.lineup_2_id::text,
              EXISTS (
                SELECT 1 FROM public.match_lineup_players mlp
                 WHERE mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                   AND mlp.steam_id = $2::bigint
              ) OR EXISTS (
                SELECT 1 FROM public.match_lineups ml
                 WHERE ml.id IN (m.lineup_1_id, m.lineup_2_id)
                   AND ml.coach_steam_id = $2::bigint
              ) AS on_lineup
         FROM public.matches m
        WHERE m.id = $1::uuid`,
      [matchId, viewer],
    );

    if (!match || !ChatService.MATCH_CHAT_LOG_STATUSES.includes(match.status)) {
      return null;
    }

    const key = ChatService.archiveKey(matchId);

    const [stored, expiresAt] = await Promise.all([
      this.redis.hgetall(key),
      this.redis.call("PEXPIRETIME", key) as Promise<number>,
    ]);

    const entries = Object.values(stored)
      .map((raw) => JSON.parse(raw) as MatchChatArchiveEntry)
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

    const withheld =
      match.on_lineup ||
      entries.some(
        (entry) => entry.room !== "match" && entry.from?.steam_id === viewer,
      );

    return {
      match: entries.filter((entry) => entry.room === "match"),
      teams: withheld
        ? []
        : [match.lineup_1_id, match.lineup_2_id]
            .filter((lineupId): lineupId is string => !!lineupId)
            .map((lineupId) => ({
              lineup_id: lineupId,
              messages: entries.filter((entry) => entry.room === lineupId),
            })),
      team_chat_withheld: withheld,
      expires_at: expiresAt > 0 ? new Date(expiresAt).toISOString() : null,
    };
  }

  private static archiveKey(matchId: string) {
    return `chat:archive:${matchId}`;
  }

  private static archiveRoom(
    type: ChatLobbyType,
    id: string,
  ): { matchId: string; room: string } | null {
    if (type === ChatLobbyType.Match) {
      return { matchId: id, room: "match" };
    }

    if (type === ChatLobbyType.MatchTeam) {
      const [matchId, lineupId] = id.split(":");

      if (matchId && lineupId) {
        return { matchId, room: lineupId };
      }
    }

    return null;
  }

  private async archiveMessages(
    type: ChatLobbyType,
    id: string,
    messages: ChatMessage[],
  ) {
    const target = ChatService.archiveRoom(type, id);

    if (!target || messages.length === 0) {
      return;
    }

    const key = ChatService.archiveKey(target.matchId);

    await this.redis.hset(
      key,
      Object.fromEntries(
        messages.map((message): [string, string] => [
          message.id,
          JSON.stringify({
            id: message.id,
            room: target.room,
            message: message.message,
            timestamp: message.timestamp,
            source: message.source,
            from: {
              steam_id: String(message.from.steam_id),
              name: message.from.name,
            },
          } satisfies MatchChatArchiveEntry),
        ]),
      ),
    );
    await this.redis.expire(key, ChatService.MATCH_CHAT_ARCHIVE_TTL);
  }

  private async updateArchivedMessage(
    type: ChatLobbyType,
    id: string,
    messageId: string,
    change: (entry: MatchChatArchiveEntry) => MatchChatArchiveEntry,
  ) {
    const target = ChatService.archiveRoom(type, id);

    if (!target) {
      return;
    }

    const key = ChatService.archiveKey(target.matchId);
    const raw = await this.redis.hget(key, messageId);

    if (!raw) {
      return;
    }

    await this.redis.hset(
      key,
      messageId,
      JSON.stringify(change(JSON.parse(raw))),
    );
    await this.redis.expire(key, ChatService.MATCH_CHAT_ARCHIVE_TTL);
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
    const moved = await this.redis.eval(
      ChatService.MOVE_ROOM_MESSAGES_SCRIPT,
      4,
      `chat_${fromType}_${fromId}`,
      `chat_${toType}_${toId}`,
      ChatService.reactionsKey(fromType, fromId),
      ChatService.reactionsKey(toType, toId),
      this.ttlFor(toType),
    );

    await this.removeLobby(fromType, fromId);

    if (moved === 0) {
      return;
    }

    const messages = await this.getRoomMessages(toType, toId);

    await this.archiveMessages(toType, toId, messages);

    void this.resendHistory(toType, toId, messages).catch((error) => {
      this.logger.warn(`unable to re-send history to ${toType}:${toId}`, error);
    });
  }
}
